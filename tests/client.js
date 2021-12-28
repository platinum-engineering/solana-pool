const solana_web3 = require('@solana/web3.js');
const anchor = require('@project-serum/anchor');
const { TokenInstructions } = require('@project-serum/serum');
const _ = require('lodash');

const idl = require('../target/idl/solana_pool.json');

const programId = new solana_web3.PublicKey(idl.metadata.address);

async function getPools(provider) {
  const program = new anchor.Program(idl, programId, provider);
  const pools = (await program.account.pool.all())
    .map((pool) => new Pool(pool));
  return pools;
}

async function getOwnedTickets(provider, owner) {
  if (owner === undefined) {
    owner = provider.wallet.publicKey;
  }
  const program = new anchor.Program(idl, programId, provider);
  return await program.account.ticket.all([
    {
      memcmp: {
        // 8 bytes for discriminator
        offset: 8,
        bytes: owner.toBase58(),
      },
    },
  ]
  );
}

class Pool {
  constructor(data) {
    // pool objects come in two flavors:
    // { publicKey: "...", account: { props } }
    // { props }
    if (data.hasOwnProperty('account')) {
      _.extend(this, data.account);
      this.publicKey = data.publicKey;
    } else {
      _.extend(this, data);
    }
  }
  async prepareTicket(staker) {
    const [ticket, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        this.publicKey.toBuffer(),
        staker.toBuffer(),
      ],
      programId,
    );
    return { publicKey: ticket, bump };
  }
  async addStake(provider, amount, ticket, accounts) {
    const program = new anchor.Program(idl, programId, provider);

    return await program.rpc.addStake(
      amount, ticket.bump,
      {
        accounts: {
          pool: this.publicKey,
          staker: accounts.staker,
          ticket: ticket.publicKey,
          stakeVault: accounts.stakeVault,
          sourceAuthority: accounts.sourceAuthority,
          sourceWallet: accounts.sourceWallet,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          tokenProgram: TokenInstructions.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
      }
    );
  }
  async removeStake(provider, amount, accounts) {
    const program = new anchor.Program(idl, programId, provider);

    const poolAuthority = await anchor.web3.PublicKey.createProgramAddress(
      [
        this.publicKey.toBuffer(),
        this.admin.toBuffer(),
        [this.bump],
      ],
      programId
    );

    return await program.rpc.removeStake(
      amount,
      {
        accounts: {
          pool: this.publicKey,
          staker: accounts.staker,
          ticket: accounts.ticket,
          poolAuthority,
          stakeVault: accounts.stakeVault,
          targetWallet: accounts.targetWallet,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          tokenProgram: TokenInstructions.TOKEN_PROGRAM_ID,
        }
      }
    );
  }

  async addReward(provider, amount, accounts) {
    const program = new anchor.Program(idl, programId, provider);

    return await program.rpc.addReward(
      amount,
      {
        accounts: {
          tokenProgram: TokenInstructions.TOKEN_PROGRAM_ID,
          pool: this.publicKey,
          stakeVault: accounts.stakeVault,
          sourceAuthority: accounts.sourceAuthority,
          sourceWallet: accounts.sourceWallet,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        }
      }
    );
  }

  async claimReward(provider, accounts) {
    const program = new anchor.Program(idl, programId, provider);

    const poolAuthority = await anchor.web3.PublicKey.createProgramAddress(
      [
        this.publicKey.toBuffer(),
        this.admin.toBuffer(),
        [this.bump],
      ],
      programId
    );

    return await program.rpc.claimReward(
      {
        accounts: {
          tokenProgram: TokenInstructions.TOKEN_PROGRAM_ID,
          pool: this.publicKey,
          staker: accounts.staker,
          ticket: accounts.ticket,
          poolAuthority,
          stakeVault: accounts.stakeVault,
          targetWallet: accounts.targetWallet,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        }
      }
    )
  }
  expectedAPY() {
    const rewardAmount = this.rewardAmount.toNumber().toFixed(20);
    const stakeTargetAmount = this.stakeTargetAmount.toNumber().toFixed(20);
    const rate = rewardAmount / stakeTargetAmount;

    const periodsInYear = this.calcPeriodsInYear();
    const annualRate = rate * periodsInYear;

    return calcAPY(annualRate, periodsInYear);
  }
  APY() {
    const depositedRewardAmount = this.depositedRewardAmount.toNumber().toFixed(20);
    const stakeAcquiredAmount = this.stakeAcquiredAmount.toNumber().toFixed(20);
    const rate = depositedRewardAmount / stakeAcquiredAmount;

    const periodsInYear = this.calcPeriodsInYear();
    const annualRate = rate * periodsInYear;

    return calcAPY(annualRate, periodsInYear);
  }
  calcPeriodsInYear() {
    const lockupDuration = this.lockupDuration.toNumber().toFixed(20);
    return Math.round(secondsInYear() / lockupDuration);
  }
  totalPoolDeposits() {
    return this.stakeAcquiredAmount;
  }
  maxPoolSize() {
    return this.stakeTargetAmount;
  }
  totalRewards() {
    return this.rewardAmount;
  }
  rewardsRemaining() {
    return this.depositedRewardAmount;
  }
  startDate() {
    return new Date(this.genesis.toNumber() * 1000);
  }
  endDate() {
    let date = this.startDate();
    date.setSeconds(date.getSeconds() + this.lockupDuration.toNumber());
    return date;
  }
  topupEndDate() {
    let date = this.startDate();
    date.setSeconds(date.getSeconds() + this.topupDuration.toNumber());
    return date;
  }
  timeToDeposit() {
    let now = new Date();
    let topupEnd = this.topupEndDate();
    return Math.ceil((topupEnd - now) / 1000);
  }
  timeUntilWithdrawal() {
    let now = new Date();
    let lockupEnd = this.endDate();
    return Math.ceil((lockupEnd - now) / 1000);
  }
}

function leapYear(year) {
  return ((year % 4 == 0) && (year % 100 != 0)) || (year % 400 == 0);
}

function secondsInYear() {
  const year = new Date().getFullYear();
  const days = leapYear(year) ? 366 : 365;

  return days * 24 * 60 * 60;
}

function calcAPY(annualRate, periodsInYear) {
  return (1 + annualRate / periodsInYear) ** periodsInYear - 1;
}

module.exports = {
  getPools,
  getOwnedTickets,
  Pool,
};
