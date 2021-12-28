const anchor = require('@project-serum/anchor');
const serumCmn = require('@project-serum/common');
const assert = require("assert");

const poolClient = require("./client");

describe('pool', () => {
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Pool;

  const pool = anchor.web3.Keypair.generate();

  let
    stakeMint: anchor.web3.PublicKey,
    sourceWallet: anchor.web3.PublicKey,
    stakeVault: anchor.web3.PublicKey,
    poolAccount,
    ticket;

  it('Calculates the APY', () => {
    const data = {
      stakeTargetAmount: new anchor.BN(10000),
      rewardAmount: new anchor.BN(1000),
      lockupDuration: new anchor.BN(60 * 60 * 24 * 7), // week
      stakeAcquiredAmount: new anchor.BN(10000),
      depositedRewardAmount: new anchor.BN(500),
    };
    const pool = new poolClient.Pool(data);

    assert.ok(pool.expectedAPY() === 141.04293198443193);
    assert.ok(pool.APY() === 11.642808263793455);
  });

  it('Initializes the pool', async () => {
    [stakeMint, sourceWallet] = await serumCmn.createMintAndVault(program.provider, new anchor.BN(200));

    const [poolAuthority, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [
        pool.publicKey.toBuffer(),
        provider.wallet.publicKey.toBuffer(),
      ],
      program.programId
    );

    stakeVault = await serumCmn.createTokenAccount(
      provider,
      stakeMint,
      poolAuthority
    );

    const topupDuration = new anchor.BN(3);
    const lockupDuration = new anchor.BN(6);
    const targetAmount = new anchor.BN(10000);
    const rewardAmount = new anchor.BN(100);

    await program.rpc.initializePool(
      {
        bump,
        topupDuration,
        lockupDuration,
        targetAmount,
        rewardAmount,
      },
      {
        accounts: {
          admin: provider.wallet.publicKey,
          poolAuthority,
          pool: pool.publicKey,
          stakeMint,
          stakeVault,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [pool],
      });

    const pools = await poolClient.getPools(provider);
    console.log('Known pools: ', pools);
    assert.ok(pools.length == 1);

    const createdPool = pools[0];

    console.log('Start date:', createdPool.startDate());
    console.log('End date:', createdPool.endDate());
    console.log('Topup end date:', createdPool.topupEndDate());
    console.log('Time to deposit:', createdPool.timeToDeposit());
    console.log('Time until withdrawal:', createdPool.timeUntilWithdrawal());

    assert.ok(createdPool.publicKey.equals(pool.publicKey));

    assert.ok(createdPool.topupDuration.eq(topupDuration));
    assert.ok(createdPool.lockupDuration.eq(lockupDuration));
    assert.ok(createdPool.stakeTargetAmount.eq(targetAmount));
    assert.ok(createdPool.rewardAmount.eq(rewardAmount));
  });

  it('Adds stake to the pool', async () => {
    const amount = new anchor.BN(100);

    const pools = await poolClient.getPools(provider);
    const createdPool = pools[0];
    ticket = await createdPool.prepareTicket(provider.wallet.publicKey);

    await createdPool.addStake(provider, amount, ticket, {
      stakeVault,
      sourceAuthority: provider.wallet.publicKey,
      sourceWallet,
      staker: provider.wallet.publicKey,
    });

    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    console.log('Data: ', poolAccount);

    assert.ok(poolAccount.stakeAcquiredAmount.eq(amount));

    const ownedTickets = await poolClient.getOwnedTickets(provider);
    assert.equal(ownedTickets.length, 1);

    const ticketAccount = ownedTickets[0];
    console.log('Data: ', ticketAccount);

    assert.ok(ticketAccount.account.stakedAmount.eq(amount));
    assert.ok(ticketAccount.account.authority.equals(provider.wallet.publicKey));

    const stakeVaultAccount = await serumCmn.getTokenAccount(provider, stakeVault);
    assert.ok(stakeVaultAccount.amount.eqn(100));
  });

  it('Removes the stake from the pool', async () => {
    const amount = new anchor.BN(50);

    const pools = await poolClient.getPools(provider);
    const createdPool = pools[0];

    await createdPool.removeStake(provider, amount, {
      staker: provider.wallet.publicKey,
      ticket: ticket.publicKey,
      stakeVault,
      targetWallet: sourceWallet
    });

    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    console.log('Data: ', poolAccount);

    assert.ok(poolAccount.stakeAcquiredAmount.eq(amount));

    const targetWallet = await serumCmn.getTokenAccount(provider, sourceWallet);
    assert.ok(targetWallet.amount.eqn(150));

    const stakeVaultAccount = await serumCmn.getTokenAccount(provider, stakeVault);
    assert.ok(stakeVaultAccount.amount.eq(amount));
  });

  it('Adds the reward to the pool', async () => {
    const amount = new anchor.BN(100);

    const pools = await poolClient.getPools(provider);
    const createdPool = pools[0];

    await createdPool.addReward(provider, amount, {
      stakeVault,
      sourceAuthority: provider.wallet.publicKey,
      sourceWallet,
    });

    const poolAccount = await program.account.pool.fetch(pool.publicKey);
    console.log('Data: ', poolAccount);

    assert.ok(poolAccount.depositedRewardAmount.eq(amount));

    const stakeVaultAccount = await serumCmn.getTokenAccount(provider, stakeVault);
    assert.ok(stakeVaultAccount.amount.eqn(150));
  });

  it('Claims the reward from the pool', async () => {
    const amountBefore = 50;

    let poolAccount = await program.account.pool.fetch(pool.publicKey);
    assert.ok(poolAccount.stakeAcquiredAmount.eqn(amountBefore));

    let ticketAccount = await program.account.ticket.fetch(ticket.publicKey);
    assert.ok(ticketAccount.stakedAmount.eqn(amountBefore));

    poolAccount = await program.account.pool.fetch(pool.publicKey);
    assert.ok(poolAccount.stakeAcquiredAmount.eqn(50));

    let stakeVaultAccount = await serumCmn.getTokenAccount(provider, stakeVault);
    console.log('Stake vault holds ', stakeVaultAccount.amount.toNumber());
    assert.ok(stakeVaultAccount.amount.eqn(150));

    const pools = await poolClient.getPools(provider);
    const createdPool = pools[0];

    while (true) {
      try {
        await createdPool.claimReward(provider, {
          staker: provider.wallet.publicKey,
          ticket: ticket.publicKey,
          stakeVault,
          targetWallet: sourceWallet,
        });
        break;
      } catch (err) {
        assert.equal(err.code, 6007);
        await serumCmn.sleep(3000);
      }
    }

    stakeVaultAccount = await serumCmn.getTokenAccount(provider, stakeVault);
    console.log('Stake vault holds ', stakeVaultAccount.amount.toNumber());
    assert.ok(stakeVaultAccount.amount.eqn(0));

    const targetWallet = await serumCmn.getTokenAccount(provider, sourceWallet);
    console.log('Target wallet holds ', targetWallet.amount.toNumber());
    // 100 - 100 + 50 + 150
    assert.ok(targetWallet.amount.eqn(200));

    assert.rejects(
      async () => await program.account.ticket.fetch(ticket),
      /^Error: Account does not exist/
    );
  });
});
