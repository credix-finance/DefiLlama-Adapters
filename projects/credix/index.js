const ADDRESSES = require("../helper/coreAssets.json");
const BigNumber = require("bignumber.js");
const { PublicKey } = require("@solana/web3.js");
const { Program, utils, BN } = require("@project-serum/anchor");
const { getProvider, sumTokens2, sumTokens } = require("../helper/solana");

const MAX_NUMBER_OF_ACCOUNT_INFOS = 99;
const MARKET_SEED_FINTECH = "credix-marketplace";
const MARKET_SEED_RECEIVABLES = "receivables-factoring";
const USDC = ADDRESSES.solana.USDC;
const programId = new PublicKey("CRDx2YkdtYtGZXGHZ59wNv1EwKHQndnRc1gT4p8i2vPX");
const encodeSeedString = (seedString) =>
  Buffer.from(utils.bytes.utf8.encode(seedString));

const constructProgram = (provider) => {
  return new Program(idl, programId, provider);
};

const findPDA = async (seeds) => {
  return PublicKey.findProgramAddress(seeds, programId);
};

const findGlobalMarketStatePDA = async (globalMarketSeed) => {
  const seed = encodeSeedString(globalMarketSeed);
  return findPDA([seed]);
};

const findSigningAuthorityPDA = async (globalMarketSeed) => {
  const globalMarketStatePDA = await findGlobalMarketStatePDA(globalMarketSeed);
  const seeds = [globalMarketStatePDA[0].toBuffer()];
  return findPDA(seeds);
};

const findDealPda = (marketPk, borrowerPk, dealNumber) => {
  const dealSeed = encodeSeedString("deal-info");
  const dealNumberSeed = new BN(dealNumber).toArrayLike(Buffer, "le", 2);
  const seeds = [
    marketPk.toBuffer(),
    borrowerPk.toBuffer(),
    dealNumberSeed,
    dealSeed,
  ];
  return findPDA(seeds);
};

async function generateRepaymentSchedulePDA(deal, globalMarketSeed) {
  const marketAdress = await findGlobalMarketStatePDA(globalMarketSeed);
  const seed = [
    marketAdress[0].toBuffer(),
    deal.publicKey.toBuffer(),
    encodeSeedString("repayment-schedule"),
  ];
  return PublicKey.findProgramAddress(seed, programId);
}

async function generateTranchesPDA(deal, globalMarketSeed) {
  const marketAdress = await findGlobalMarketStatePDA(globalMarketSeed);
  const seed = [
    marketAdress[0].toBuffer(),
    deal.publicKey.toBuffer(),
    encodeSeedString("tranches"),
  ];
  return PublicKey.findProgramAddress(seed, programId);
}

function openedAt(deal) {
  const openedAt = deal.openedAt;
  return openedAt.bitLength() > 53 ? null : openedAt.toNumber();
}

function goLiveAt(deal) {
  const goLiveAt = deal.goLiveAt;
  return goLiveAt.bitLength() > 53 ? null : goLiveAt.toNumber();
}

function trancheRepaid(tranche) {
  return (
    Number(tranche.outstandingPrincipal) === 0 &&
    !Object.values(tranche.amountsDue).some((val) => Number(val) !== 0)
  );
}
function isRepaid(tranches) {
  return !tranches.tranches.some((t) => !trancheRepaid(t));
}

function outstandingArrangementFees(deal) {
  const arrangementFees = Number(deal.arrangementFees);
  const arrangementFeesRepaid = Number(deal.arrangementFeesRepaid);

  return arrangementFees - arrangementFeesRepaid;
}

function totalOutstandingCreditTranches(tranches) {
  tranches.tranches.reduce((a, t) => a + t.tranche.outstandingPrincipal, 0);
}

function status(deal, tranches, schedule) {
  if (schedule?.totalPeriods !== schedule?.periods.length) {
    return "STRUCTURING";
  }

  if (!deal.openedAt) {
    return "PENDING";
  }

  if (!deal.goLiveAt) {
    return "OPEN_FOR_FUNDING";
  }

  //TODO: add service fee check
  if (isRepaid(tranches) && outstandingArrangementFees(deal) === 0) {
    return "CLOSED";
  }

  return "IN_PROGRESS";
}

function isInProgress(deal, tranches, schedule) {
  const dealStatus = status(deal.account, tranches, schedule);
  return dealStatus === "IN_PROGRESS";
}

function chunk(inputArray, perChunk) {
  const result = inputArray.reduce((resultArray, item, index) => {
    const chunkIndex = Math.floor(index / perChunk);

    if (!resultArray[chunkIndex]) {
      resultArray[chunkIndex] = []; // start a new chunk
    }

    resultArray[chunkIndex].push(item);

    return resultArray;
  }, []);

  return result;
}

async function asyncFilter(arr, filter) {
  const results = await Promise.all(arr.map(filter));
  return arr.filter((_, i) => results[i]);
}

async function filterDealsForMarket(deals, globalMarketSeed) {
  const [globalMarketStatePk] = await findGlobalMarketStatePDA(
    globalMarketSeed
  );
  const marketDeals = await asyncFilter(deals, async (deal) => {
    const [dealPDA] = await findDealPda(
      globalMarketStatePk,
      deal.account.borrower,
      deal.account.dealNumber
    );
    return dealPDA.equals(deal.publicKey);
  });
  return marketDeals;
}

async function fetchRepaymentScheduleForDeals(
  program,
  provider,
  deals,
  globalMarketSeed
) {
  const pdaPromises = deals.map((d) =>
    generateRepaymentSchedulePDA(d, globalMarketSeed)
  );
  const pdas = await Promise.all(pdaPromises);
  const addresses = pdas.map((pda) => pda[0]);
  const addressesChunks = chunk(addresses, MAX_NUMBER_OF_ACCOUNT_INFOS - 1);
  const accountInfosChunks = await Promise.all(
    addressesChunks.map((addressChunk) => {
      const accInfos =
        provider.connection.getMultipleAccountsInfo(addressChunk);
      return accInfos;
    })
  );
  const accountInfos = accountInfosChunks.flat();

  const programVersions = accountInfos.map(
    (accountInfo) =>
      accountInfo &&
      program.coder.accounts.decode("repaymentSchedule", accountInfo.data)
  );
  return programVersions;
}

async function fetchTranchesForDeals(
  program,
  provider,
  deals,
  globalMarketSeed
) {
  const pdaPromises = deals.map((d) =>
    generateTranchesPDA(d, globalMarketSeed)
  );
  const pdas = await Promise.all(pdaPromises);
  const addresses = pdas.map((pda) => pda[0]);
  const addressesChunks = chunk(addresses, MAX_NUMBER_OF_ACCOUNT_INFOS - 1);
  const accountInfosChunks = await Promise.all(
    addressesChunks.map((addressChunk) => {
      const accInfos =
        provider.connection.getMultipleAccountsInfo(addressChunk);
      return accInfos;
    })
  );
  const accountInfos = accountInfosChunks.flat();

  const programVersions = accountInfos.map(
    (accountInfo) =>
      accountInfo &&
      program.coder.accounts.decode("dealTranches", accountInfo.data)
  );
  return programVersions;
}

async function tvl() {
  // Fintech pool
  const [signingAuthorityKeyFintech] = await findSigningAuthorityPDA(
    MARKET_SEED_FINTECH
  );

  // Receivables factoring pool
  const [signingAuthorityKeyReceivables] = await findSigningAuthorityPDA(
    MARKET_SEED_RECEIVABLES
  );
  const tokens = await sumTokens2({
    tokensAndOwners: [
      [USDC, signingAuthorityKeyFintech],
      [USDC, signingAuthorityKeyReceivables],
    ],
  });
  return tokens;
}

function asyncMap(arr, map) {
  return Promise.all(arr.map(map));
}

async function fetchOutstandingCreditPool(
  provider,
  program,
  deals,
  globalMarketSeed
) {
  const marketDeals = await filterDealsForMarket(deals, globalMarketSeed);
  const schedules = await fetchRepaymentScheduleForDeals(
    program,
    provider,
    marketDeals,
    globalMarketSeed
  );
  const tranches = await fetchTranchesForDeals(
    program,
    provider,
    marketDeals,
    globalMarketSeed
  );

  const dealTuples = deals
    .map((deal, i) => {
      const schedule = schedules[i];
      const dealTranches = tranches[i];

      if (!schedule) return null;
      if (!dealTranches) return null;

      return [deal, schedule, dealTranches];
    })
    .filter((dealTuple) => !!dealTuple);

  const inProgressTranches = (
    await asyncMap(dealTuples, async ([deal, schedule, dealTranches]) => {
      if (isInProgress(deal, dealTranches, schedule)) {
        return dealTranches;
      }

      return null;
    })
  ).filter((x) => !!x);

  const totalOutstandingCredit = inProgressTranches.reduce(
    (a, t) => a + totalOutstandingCreditTranches(t),
    0
  );

  console.log("totalOutstandingCredit", totalOutstandingCredit);

  return totalOutstandingCredit;
}

async function borrowed() {
  const provider = getProvider();
  const program = constructProgram(provider);
  const allDeals = await program.account.deal.all();

  // FinTech pool
  const totalOutstandingCreditFintech = await fetchOutstandingCreditPool(
    provider,
    program,
    allDeals,
    MARKET_SEED_FINTECH
  );

  // Receivables factoring pool
  const totalOutstandingCreditReceivables = await fetchOutstandingCreditPool(
    provider,
    program,
    allDeals,
    MARKET_SEED_RECEIVABLES
  );

  console.log("jow", totalOutstandingCreditFintech.toString());
  console.log("jow", totalOutstandingCreditReceivables.toString());

  return {
    ["solana:" + USDC]: totalOutstandingCreditFintech
      .plus(totalOutstandingCreditReceivables)
      .toString(),
  };
}

module.exports = {
  timetravel: false,
  solana: {
    tvl,
    borrowed,
  },
};

const idl = {
  version: "3.11.0",
  name: "credix",
  instructions: [],
  accounts: [
    {
      name: "deserializableDeal",
      type: {
        kind: "struct",
        fields: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "borrower",
            type: "publicKey",
          },
          {
            name: "amountWithdrawn",
            type: "u64",
          },
          {
            name: "goLiveAt",
            type: "i64",
          },
          {
            name: "createdAt",
            type: "i64",
          },
          {
            name: "maxFundingDuration",
            type: "u8",
          },
          {
            name: "dealNumber",
            type: "u16",
          },
          {
            name: "bump",
            type: "u8",
          },
          {
            name: "openedAt",
            type: "i64",
          },
          {
            name: "arrangementFees",
            type: "u64",
          },
          {
            name: "arrangementFeesRepaid",
            type: "u64",
          },
          {
            name: "timeLatestArrangementFeesCharged",
            type: "i64",
          },
          {
            name: "migrated",
            type: "bool",
          },
          {
            name: "originalGoLiveAt",
            type: "i64",
          },
          {
            name: "prevUpdateTs",
            type: {
              option: "i64",
            },
          },
          {
            name: "arrangementFee",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "collectionTokenAccount",
            type: {
              option: "publicKey",
            },
          },
          {
            name: "offRampTokenAccount",
            type: {
              option: "publicKey",
            },
          },
        ],
      },
    },
    {
      name: "mainnetDealTranches",
      type: {
        kind: "struct",
        fields: [
          {
            name: "bump",
            type: "u8",
          },
          {
            name: "totalTranches",
            type: "u8",
          },
          {
            name: "tranches",
            type: {
              vec: {
                defined: "MainnetDealTranche",
              },
            },
          },
        ],
      },
    },
    {
      name: "borrowerInfo",
      type: {
        kind: "struct",
        fields: [
          {
            name: "numOfDeals",
            type: "u16",
          },
          {
            name: "bump",
            type: "u8",
          },
        ],
      },
    },
    {
      name: "credixPass",
      type: {
        kind: "struct",
        fields: [
          {
            name: "bump",
            type: "u8",
          },
          {
            name: "isBorrower",
            type: "bool",
          },
          {
            name: "isInvestor",
            type: "bool",
          },
          {
            name: "active",
            type: "bool",
          },
          {
            name: "releaseTimestamp",
            type: "i64",
          },
          {
            name: "user",
            type: "publicKey",
          },
          {
            name: "disableWithdrawalFee",
            type: "bool",
          },
          {
            name: "bypassWithdrawEpochs",
            type: "bool",
          },
          {
            name: "withdrawCap",
            type: {
              option: {
                defined: "WithdrawCap",
              },
            },
          },
        ],
      },
    },
    {
      name: "crossChainInvestor",
      type: {
        kind: "struct",
        fields: [
          {
            name: "bump",
            type: "u8",
          },
          {
            name: "chainId",
            type: "u16",
          },
          {
            name: "investorChainAddress",
            type: "publicKey",
          },
        ],
      },
    },
    {
      name: "dealClaims",
      type: {
        kind: "struct",
        fields: [
          {
            name: "trancheClaims",
            type: {
              vec: {
                defined: "TrancheClaim",
              },
            },
          },
          {
            name: "lpClaims",
            type: {
              vec: {
                defined: "LpClaim",
              },
            },
          },
        ],
      },
    },
    {
      name: "dealTranches",
      type: {
        kind: "struct",
        fields: [
          {
            name: "bump",
            type: "u8",
          },
          {
            name: "totalTranches",
            type: "u8",
          },
          {
            name: "tranches",
            type: {
              vec: {
                defined: "DealTranche",
              },
            },
          },
        ],
      },
    },
    {
      name: "deal",
      type: {
        kind: "struct",
        fields: [
          {
            name: "name",
            type: "string",
          },
          {
            name: "borrower",
            type: "publicKey",
          },
          {
            name: "amountWithdrawn",
            docs: [
              "The principal amount withdrawn from deal token account by borrower",
            ],
            type: "u64",
          },
          {
            name: "goLiveAt",
            type: "i64",
          },
          {
            name: "createdAt",
            type: "i64",
          },
          {
            name: "maxFundingDuration",
            docs: [
              "The number of days after tranche investors can call burn tranches if the deal does not goes live.",
            ],
            type: "u8",
          },
          {
            name: "dealNumber",
            type: "u16",
          },
          {
            name: "bump",
            type: "u8",
          },
          {
            name: "openedAt",
            type: "i64",
          },
          {
            name: "arrangementFees",
            type: "u64",
          },
          {
            name: "arrangementFeesRepaid",
            type: "u64",
          },
          {
            name: "timeLatestArrangementFeesCharged",
            docs: [
              "Used to keep track of the year arrangement fee is charged for.",
            ],
            type: "i64",
          },
          {
            name: "migrated",
            docs: ["true when we bring off chain deal onchain."],
            type: "bool",
          },
          {
            name: "originalGoLiveAt",
            docs: [
              "When upscaling we store the `go_live_at` timestamp here and reset `go_live_at`.",
              "We do this so the deal is no longer regarded as in progress, requiring a new activation.",
              "Across all upscales, the initial point of activation should always be regarded as the `go_live_at` so we need to be able to restore it.",
            ],
            type: "i64",
          },
          {
            name: "prevUpdateTs",
            docs: [
              "The timestamp of the last time the due amounts were updated",
            ],
            type: {
              option: "i64",
            },
          },
          {
            name: "arrangementFee",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "collectionTokenAccount",
            type: {
              option: "publicKey",
            },
          },
          {
            name: "offRampTokenAccount",
            type: {
              option: "publicKey",
            },
          },
          {
            name: "arrangementFeeCollectionTokenAccount",
            type: {
              option: "publicKey",
            },
          },
        ],
      },
    },
    {
      name: "globalMarketState",
      type: {
        kind: "struct",
        fields: [
          {
            name: "baseTokenMint",
            type: "publicKey",
          },
          {
            name: "lpTokenMint",
            type: "publicKey",
          },
          {
            name: "poolOutstandingCredit",
            docs: ["The amount from senior tranche lent"],
            type: "u64",
          },
          {
            name: "treasuryPoolTokenAccount",
            type: "publicKey",
          },
          {
            name: "signingAuthorityBump",
            type: "u8",
          },
          {
            name: "bump",
            type: "u8",
          },
          {
            name: "credixFeePercentage",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "withdrawalFee",
            docs: ["The fee charged for withdrawals"],
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "frozen",
            type: "bool",
          },
          {
            name: "seed",
            type: "string",
          },
          {
            name: "poolSizeLimitPercentage",
            docs: [
              "Maximum possible deposit limit in addition the pool outstanding credit",
              "pool_size_limit = pool_outstanding_credit + pool_size_limit_percentage * pool_outstanding_credit",
            ],
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "withdrawEpochRequestSeconds",
            type: "u32",
          },
          {
            name: "withdrawEpochRedeemSeconds",
            type: "u32",
          },
          {
            name: "withdrawEpochAvailableLiquiditySeconds",
            type: "u32",
          },
          {
            name: "latestWithdrawEpochIdx",
            type: "u32",
          },
          {
            name: "latestWithdrawEpochEnd",
            type: "i64",
          },
          {
            name: "lockedLiquidity",
            type: "u64",
          },
          {
            name: "totalRedeemedBaseAmount",
            type: "u64",
          },
          {
            name: "hasWithdrawEpochs",
            type: "bool",
          },
          {
            name: "redeemAuthorityBump",
            docs: [
              "This is only used for wormhole related token transfer occurs.",
            ],
            type: "u8",
          },
        ],
      },
    },
    {
      name: "managedBorrower",
      type: {
        kind: "struct",
        fields: [
          {
            name: "borrowerName",
            type: "string",
          },
        ],
      },
    },
    {
      name: "marketAdmins",
      type: {
        kind: "struct",
        fields: [
          {
            name: "multisig",
            type: "publicKey",
          },
          {
            name: "managers",
            type: {
              vec: "publicKey",
            },
          },
          {
            name: "passIssuers",
            type: {
              vec: "publicKey",
            },
          },
        ],
      },
    },
    {
      name: "programState",
      type: {
        kind: "struct",
        fields: [
          {
            name: "credixMultisigKey",
            type: "publicKey",
          },
          {
            name: "credixManagers",
            type: {
              array: ["publicKey", 10],
            },
          },
        ],
      },
    },
    {
      name: "repaymentSchedule",
      type: {
        kind: "struct",
        fields: [
          {
            name: "totalPeriods",
            type: "u16",
          },
          {
            name: "startTs",
            type: "i64",
          },
          {
            name: "daycountConvention",
            type: {
              defined: "DaycountConvention",
            },
          },
          {
            name: "periods",
            type: {
              vec: {
                defined: "RepaymentPeriod",
              },
            },
          },
          {
            name: "waterfallDefinitions",
            type: {
              vec: {
                defined: "DistributionWaterfall",
              },
            },
          },
        ],
      },
    },
    {
      name: "trancheInfo",
      type: {
        kind: "struct",
        fields: [
          {
            name: "snapshots",
            type: {
              vec: {
                defined: "TrancheSnapshot",
              },
            },
          },
        ],
      },
    },
    {
      name: "tranchePass",
      type: {
        kind: "struct",
        fields: [
          {
            name: "bump",
            type: "u8",
          },
          {
            name: "active",
            type: "bool",
          },
          {
            name: "investor",
            type: "publicKey",
          },
          {
            name: "deal",
            type: "publicKey",
          },
          {
            name: "trancheIndex",
            type: "u8",
          },
          {
            name: "deposits",
            docs: ["The legacy deposits are not added to this vec."],
            type: {
              vec: {
                defined: "UpscaleDeposits",
              },
            },
          },
          {
            name: "amountWithdrawn",
            type: "u64",
          },
        ],
      },
    },
    {
      name: "withdrawEpoch",
      type: {
        kind: "struct",
        fields: [
          {
            name: "goLive",
            type: "i64",
          },
          {
            name: "requestSeconds",
            type: "u32",
          },
          {
            name: "redeemSeconds",
            type: "u32",
          },
          {
            name: "availableLiquiditySeconds",
            type: "u32",
          },
          {
            name: "totalRequestedBaseAmount",
            type: "u64",
          },
          {
            name: "participatingInvestorsTotalLpAmount",
            type: "u64",
          },
        ],
      },
    },
    {
      name: "withdrawRequest",
      type: {
        kind: "struct",
        fields: [
          {
            name: "baseAmount",
            type: "u64",
          },
          {
            name: "baseAmountWithdrawn",
            type: "u64",
          },
          {
            name: "investorTotalLpAmount",
            type: "u64",
          },
        ],
      },
    },
  ],
  types: [
    {
      name: "MainnetDealTranche",
      type: {
        kind: "struct",
        fields: [
          {
            name: "index",
            type: "u8",
          },
          {
            name: "amountDeposited",
            type: "u64",
          },
          {
            name: "tokenMint",
            type: "publicKey",
          },
          {
            name: "maxDepositPercentage",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "earlyWithdrawalPrincipal",
            type: "bool",
          },
          {
            name: "optionalAccount",
            type: "bool",
          },
          {
            name: "upscaleSize",
            type: "u64",
          },
          {
            name: "interestRepaidUntilLastUpscale",
            type: "u64",
          },
          {
            name: "fundedByLiquidityPool",
            type: "bool",
          },
          {
            name: "name",
            type: "string",
          },
          {
            name: "tranche",
            type: {
              defined: "Tranche",
            },
          },
        ],
      },
    },
    {
      name: "TrancheConfig",
      type: {
        kind: "struct",
        fields: [
          {
            name: "index",
            type: "u8",
          },
          {
            name: "maxDepositPercentage",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "earlyWithdrawalPrincipal",
            type: "bool",
          },
          {
            name: "fundedByLiquidityPool",
            type: "bool",
          },
          {
            name: "name",
            type: "string",
          },
          {
            name: "size",
            type: "u64",
          },
          {
            name: "interest",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "interestPerformanceFee",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "principalPerformanceFee",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "membershipFee",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "lateInterest",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "latePrincipal",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "earlyPrincipal",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "variableRate",
            type: {
              defined: "VariableRate",
            },
          },
        ],
      },
    },
    {
      name: "WithdrawCap",
      type: {
        kind: "struct",
        fields: [
          {
            name: "amountCap",
            type: "u64",
          },
          {
            name: "amountWithdrawn",
            type: "u64",
          },
        ],
      },
    },
    {
      name: "TrancheClaim",
      type: {
        kind: "struct",
        fields: [
          {
            name: "trancheIndex",
            type: "u8",
          },
          {
            name: "claimableAmount",
            type: "u64",
          },
          {
            name: "claimedAmount",
            type: "u64",
          },
          {
            name: "investor",
            type: "publicKey",
          },
        ],
      },
    },
    {
      name: "LpClaim",
      type: {
        kind: "struct",
        fields: [
          {
            name: "claimBaseAmount",
            docs: ["base amount deposited"],
            type: "u64",
          },
          {
            name: "claimableLpAmount",
            type: "u64",
          },
          {
            name: "claimedLpAmount",
            type: "u64",
          },
          {
            name: "investor",
            type: "publicKey",
          },
        ],
      },
    },
    {
      name: "TrancheClaimConfig",
      type: {
        kind: "struct",
        fields: [
          {
            name: "trancheIndex",
            type: "u8",
          },
          {
            name: "claimableAmount",
            type: "u64",
          },
          {
            name: "investor",
            type: "publicKey",
          },
        ],
      },
    },
    {
      name: "LpClaimConfig",
      type: {
        kind: "struct",
        fields: [
          {
            name: "claimBaseAmount",
            type: "u64",
          },
          {
            name: "investor",
            type: "publicKey",
          },
        ],
      },
    },
    {
      name: "DealTranche",
      type: {
        kind: "struct",
        fields: [
          {
            name: "index",
            type: "u8",
          },
          {
            name: "amountDeposited",
            type: "u64",
          },
          {
            name: "tokenMint",
            type: "publicKey",
          },
          {
            name: "maxDepositPercentage",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "earlyWithdrawalPrincipal",
            type: "bool",
          },
          {
            name: "optionalAccount",
            type: "bool",
          },
          {
            name: "upscaleSize",
            type: "u64",
          },
          {
            name: "interestRepaidUntilLastUpscale",
            type: "u64",
          },
          {
            name: "fundedByLiquidityPool",
            type: "bool",
          },
          {
            name: "name",
            type: "string",
          },
          {
            name: "tranche",
            type: {
              defined: "Tranche",
            },
          },
          {
            name: "variableRate",
            type: {
              defined: "VariableRate",
            },
          },
          {
            name: "dataPadding",
            type: {
              array: ["u32", 20],
            },
          },
        ],
      },
    },
    {
      name: "Tranche",
      type: {
        kind: "struct",
        fields: [
          {
            name: "size",
            type: "u64",
          },
          {
            name: "outstandingPrincipal",
            type: "u64",
          },
          {
            name: "rates",
            type: {
              defined: "TrancheRates",
            },
          },
          {
            name: "amountsDue",
            type: {
              defined: "TrancheAmountsDue",
            },
          },
          {
            name: "amountsRepaid",
            type: {
              defined: "TrancheAmountsRepaid",
            },
          },
        ],
      },
    },
    {
      name: "TrancheRates",
      docs: [
        "A collection of percentages used to charge various fees on tranche level",
      ],
      type: {
        kind: "struct",
        fields: [
          {
            name: "interest",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "lateInterestFee",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "interestPerformanceFee",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "latePrincipalFee",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "principalPerformanceFee",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "earlyPrincipalFee",
            type: {
              defined: "Fraction",
            },
          },
          {
            name: "membershipFee",
            type: {
              defined: "Fraction",
            },
          },
        ],
      },
    },
    {
      name: "TrancheAmountsDue",
      type: {
        kind: "struct",
        fields: [
          {
            name: "interest",
            type: "u64",
          },
          {
            name: "prevInterest",
            type: "u64",
          },
          {
            name: "principal",
            type: "u64",
          },
          {
            name: "prevPrincipal",
            type: "u64",
          },
          {
            name: "lateInterestFee",
            type: "u64",
          },
          {
            name: "latePrincipalFee",
            type: "u64",
          },
          {
            name: "interestPerformanceFee",
            type: "u64",
          },
          {
            name: "principalPerformanceFee",
            type: "u64",
          },
          {
            name: "membershipFee",
            type: "u64",
          },
          {
            name: "earlyPrincipalFee",
            type: "u64",
          },
        ],
      },
    },
    {
      name: "TrancheAmountsRepaid",
      type: {
        kind: "struct",
        fields: [
          {
            name: "interestRepaid",
            type: "u64",
          },
          {
            name: "interestPerformanceFeeRepaid",
            type: "u64",
          },
          {
            name: "principalPerformanceFeeRepaid",
            type: "u64",
          },
          {
            name: "latePrincipalFeeRepaid",
            type: "u64",
          },
          {
            name: "lateInterestFeeRepaid",
            type: "u64",
          },
          {
            name: "membershipFeeRepaid",
            type: "u64",
          },
          {
            name: "earlyPrincipalFeeRepaid",
            type: "u64",
          },
        ],
      },
    },
    {
      name: "Fraction",
      type: {
        kind: "struct",
        fields: [
          {
            name: "numerator",
            type: "u32",
          },
          {
            name: "denominator",
            type: "u32",
          },
        ],
      },
    },
    {
      name: "RepaymentPeriod",
      type: {
        kind: "struct",
        fields: [
          {
            name: "waterfallIndex",
            type: "u64",
          },
          {
            name: "accrualInDays",
            docs: [
              "Amount of days we should consider accrued in this period.",
              "",
              "This is relevant for fee calculations. The amount is not just the days between this period and the previous period as we take into account a calculation date when determining this amount.",
              "These calculations happen off-chain and we just store the result on-chain.",
            ],
            type: "u32",
          },
          {
            name: "principalExpected",
            docs: [
              "If there are principal allocations present in the waterfall of a period, we indicate that it should be a certain amount by setting this number.",
              "",
              "If it's `None`, any amount of principal can be repaid in a period, we also don't incur early fees on the principal repaid.",
            ],
            type: {
              option: "u64",
            },
          },
          {
            name: "timeFrame",
            docs: ["The time frame within which a period takes place."],
            type: {
              defined: "TimeFrame",
            },
          },
          {
            name: "calculationWaterfallIndex",
            type: "u64",
          },
        ],
      },
    },
    {
      name: "TimeFrame",
      docs: [
        "The time frame within which a period takes place.",
        "",
        "Timestamps are expressed as Unix timestamps at midnight of the relevant day.",
        "We do this because it's more convenient and universal to store timestamps but logic wise we are only concerned about days, not hours, minutes, seconds.",
      ],
      type: {
        kind: "struct",
        fields: [
          {
            name: "start",
            type: "i64",
          },
          {
            name: "end",
            type: "i64",
          },
        ],
      },
    },
    {
      name: "DistributionWaterfall",
      docs: [
        "Determines how repayments should be allocated in a repayment period.",
      ],
      type: {
        kind: "struct",
        fields: [
          {
            name: "waterfallType",
            type: {
              defined: "DistributionWaterfallType",
            },
          },
          {
            name: "tiers",
            docs: [
              "The order of the tiers determines the order of allocations of a repayment",
            ],
            type: {
              vec: {
                defined: "WaterfallTier",
              },
            },
          },
        ],
      },
    },
    {
      name: "WaterfallTier",
      docs: [
        "Represents a single tier in a distribution waterfall.",
        "",
        "If multiple allocations are present in a tier, this means the funds are distributed pro rata across allocations.",
        "",
        "If multiple tranches are present in a tier, this means that the funds per allocation are distributed pro rata across tranches.",
        "An exception might occur if there is a principal allocation.",
        "If there is not enough to fulfill the principal allocation of a tier, the pro-rata distribution changes into a sequential one if slashing is enabled.",
        "In that case, the order of the list determines the seniority of the tranches within it. First in the list is more senior.",
      ],
      type: {
        kind: "struct",
        fields: [
          {
            name: "trancheIndices",
            type: {
              vec: "u64",
            },
          },
          {
            name: "slash",
            docs: [
              "Indicates if we should slash should there be multiple indices present.",
              "",
              "If this is false we distribute pro-rata within this tier.",
              "",
              "If this is true we distribute sequentially within this tier.",
            ],
            type: "bool",
          },
          {
            name: "charge",
            docs: [
              "Indicates if we want to charge the allocations in this tier. If not, this tier is only used to help determine the repayment order.",
            ],
            type: "bool",
          },
          {
            name: "allocations",
            type: {
              vec: {
                defined: "RepaymentAllocation",
              },
            },
          },
        ],
      },
    },
    {
      name: "RepaymentPeriodInput",
      type: {
        kind: "struct",
        fields: [
          {
            name: "calculationWaterfallIndex",
            type: "u64",
          },
          {
            name: "waterfallIndex",
            type: "u64",
          },
          {
            name: "accrualInDays",
            type: "u32",
          },
          {
            name: "principalExpected",
            type: {
              option: "u64",
            },
          },
          {
            name: "timeFrame",
            type: {
              defined: "TimeFrame",
            },
          },
        ],
      },
    },
    {
      name: "TrancheSnapshot",
      type: {
        kind: "struct",
        fields: [
          {
            name: "createdAt",
            type: "i64",
          },
          {
            name: "interestRepaid",
            type: "u64",
          },
          {
            name: "principalRepaid",
            type: "u64",
          },
          {
            name: "size",
            type: "u64",
          },
        ],
      },
    },
    {
      name: "UpscaleDeposits",
      type: {
        kind: "struct",
        fields: [
          {
            name: "upscaleIndex",
            type: "u32",
          },
          {
            name: "amount",
            type: "u64",
          },
        ],
      },
    },
    {
      name: "TransferNativeData",
      type: {
        kind: "struct",
        fields: [
          {
            name: "nonce",
            type: "u32",
          },
          {
            name: "amount",
            type: "u64",
          },
          {
            name: "fee",
            type: "u64",
          },
          {
            name: "targetAddress",
            type: {
              array: ["u8", 32],
            },
          },
          {
            name: "targetChain",
            type: "u16",
          },
        ],
      },
    },
    {
      name: "TransferWrappedData",
      type: {
        kind: "struct",
        fields: [
          {
            name: "nonce",
            type: "u32",
          },
          {
            name: "amount",
            type: "u64",
          },
          {
            name: "fee",
            type: "u64",
          },
          {
            name: "targetAddress",
            type: {
              array: ["u8", 32],
            },
          },
          {
            name: "targetChain",
            type: "u16",
          },
        ],
      },
    },
    {
      name: "VariableRate",
      type: {
        kind: "enum",
        variants: [
          {
            name: "None",
          },
          {
            name: "SOFR",
          },
        ],
      },
    },
    {
      name: "DealStatus",
      type: {
        kind: "enum",
        variants: [
          {
            name: "Pending",
          },
          {
            name: "Structuring",
          },
          {
            name: "OpenForFunding",
          },
          {
            name: "InProgress",
          },
        ],
      },
    },
    {
      name: "DaycountConvention",
      type: {
        kind: "enum",
        variants: [
          {
            name: "Act360",
          },
          {
            name: "Act365",
          },
        ],
      },
    },
    {
      name: "DistributionWaterfallType",
      type: {
        kind: "enum",
        variants: [
          {
            name: "Acceleration",
          },
          {
            name: "Amortization",
          },
          {
            name: "Revolving",
          },
        ],
      },
    },
    {
      name: "RepaymentAllocation",
      type: {
        kind: "enum",
        variants: [
          {
            name: "CompoundingInterest",
          },
          {
            name: "Interest",
          },
          {
            name: "Principal",
          },
          {
            name: "InterestPerformanceFee",
          },
          {
            name: "PrincipalPerformanceFee",
          },
          {
            name: "LatePrincipalFee",
          },
          {
            name: "LateInterestFee",
          },
          {
            name: "MembershipFee",
          },
          {
            name: "EarlyPrincipalFee",
          },
        ],
      },
    },
    {
      name: "WithdrawEpochStatus",
      type: {
        kind: "enum",
        variants: [
          {
            name: "RequestPhase",
          },
          {
            name: "RedeemPhase",
          },
          {
            name: "AvailableLiquidityPhase",
          },
          {
            name: "Closed",
          },
        ],
      },
    },
    {
      name: "Instructions",
      type: {
        kind: "enum",
        variants: [
          {
            name: "Initialize",
          },
          {
            name: "AttestToken",
          },
          {
            name: "CompleteNative",
          },
          {
            name: "CompleteWrapped",
          },
          {
            name: "TransferWrapped",
          },
          {
            name: "TransferNative",
          },
          {
            name: "RegisterChain",
          },
          {
            name: "CreateWrapped",
          },
          {
            name: "UpgradeContract",
          },
          {
            name: "CompleteNativeWithPayload",
          },
          {
            name: "CompleteWrappedWithPayload",
          },
          {
            name: "TransferWrappedWithPayload",
          },
          {
            name: "TransferNativeWithPayload",
          },
        ],
      },
    },
    {
      name: "PortalError",
      type: {
        kind: "enum",
        variants: [
          {
            name: "CustomZeroError",
          },
        ],
      },
    },
  ],
  events: [],
  errors: [],
};
