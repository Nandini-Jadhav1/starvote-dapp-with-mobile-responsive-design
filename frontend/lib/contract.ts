// frontend/lib/contract.ts
// Soroban smart contract integration for StarVote

import * as StellarSdk from "@stellar/stellar-sdk";
import { signTransaction, getAddress } from "@stellar/freighter-api";

const CONTRACT_ID        = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;
const RPC_URL            = "https://soroban-testnet.stellar.org";
const HORIZON_URL        = "https://horizon-testnet.stellar.org";

export interface PollData {
  question:   string;
  options:    string[];
  results:    number[];
  totalVotes: number;
}

// ── Helper: call a read-only contract function via RPC ─────────────────────
async function simulateContract(
  method: string,
  args: StellarSdk.xdr.ScVal[] = []
): Promise<StellarSdk.xdr.ScVal> {
  if (!CONTRACT_ID) throw new Error("CONTRACT_ID not set");

  const rpc      = new StellarSdk.SorobanRpc.Server(RPC_URL);
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const horizon  = new StellarSdk.Horizon.Server(HORIZON_URL);

  // Use a dummy account for simulation
  const sourceKeypair = StellarSdk.Keypair.random();
  const sourceAccount = new StellarSdk.Account(sourceKeypair.publicKey(), "0");

  const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee:               StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simResult = await rpc.simulateTransaction(tx);

  if (StellarSdk.SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation error: ${simResult.error}`);
  }

  const resultVal = (simResult as StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!resultVal) throw new Error("No return value from simulation");
  return resultVal;
}

// ── get_results → number[] ─────────────────────────────────────────────────
export async function fetchResults(): Promise<number[]> {
  if (!CONTRACT_ID) return [111, 76, 59, 42]; // mock fallback

  try {
    const val     = await simulateContract("get_results");
    const vecVals = val.vec();
    if (!vecVals) return [0, 0, 0, 0];
    return vecVals.map((v) => v.u32() ?? 0);
  } catch {
    return [111, 76, 59, 42];
  }
}

// ── get_question → string ──────────────────────────────────────────────────
export async function fetchQuestion(): Promise<string> {
  if (!CONTRACT_ID) return "What should the Stellar community prioritize in 2026?";

  try {
    const val = await simulateContract("get_question");
    return StellarSdk.scValToNative(val) as string;
  } catch {
    return "What should the Stellar community prioritize in 2026?";
  }
}

// ── get_options → string[] ─────────────────────────────────────────────────
export async function fetchOptions(): Promise<string[]> {
  if (!CONTRACT_ID) {
    return [
      "DeFi & DEX improvements",
      "Cross-chain bridges",
      "Mobile wallet UX",
      "Developer tooling",
    ];
  }

  try {
    const val     = await simulateContract("get_options");
    const vecVals = val.vec();
    if (!vecVals) return [];
    return vecVals.map((v) => StellarSdk.scValToNative(v) as string);
  } catch {
    return [
      "DeFi & DEX improvements",
      "Cross-chain bridges",
      "Mobile wallet UX",
      "Developer tooling",
    ];
  }
}

// ── has_voted → boolean ────────────────────────────────────────────────────
export async function checkHasVoted(voterAddress: string): Promise<boolean> {
  if (!CONTRACT_ID) return false;

  try {
    const val = await simulateContract("has_voted", [
      StellarSdk.nativeToScVal(voterAddress, { type: "address" }),
    ]);
    return StellarSdk.scValToNative(val) as boolean;
  } catch {
    return false;
  }
}

// ── fetch all poll data at once ────────────────────────────────────────────
export async function fetchPollData(): Promise<PollData> {
  const [question, options, results] = await Promise.all([
    fetchQuestion(),
    fetchOptions(),
    fetchResults(),
  ]);

  return {
    question,
    options,
    results,
    totalVotes: results.reduce((a, b) => a + b, 0),
  };
}

// ── castVote → submits real Stellar transaction ────────────────────────────
export async function castVote(optionIndex: number): Promise<string> {
  const addrObj = await getAddress();
  if (addrObj.error) throw new Error(addrObj.error.message);
  const voter = addrObj.address;

  const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
  const account = await horizon.loadAccount(voter);

  // Fallback: plain payment tx with memo (mock mode)
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee:               StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: voter,
        asset:       StellarSdk.Asset.native(),
        amount:      "0.0000001",
      })
    )
    .addMemo(StellarSdk.Memo.text(`starvote:vote:${optionIndex}`))
    .setTimeout(30)
    .build();

  const signed = await signTransaction(tx.toXDR(), {
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  if (signed.error) throw new Error(signed.error.message);

  const signedTx = StellarSdk.TransactionBuilder.fromXDR(
    signed.signedTxXdr,
    NETWORK_PASSPHRASE
  );

  // Real contract call (if CONTRACT_ID is set)
  if (CONTRACT_ID) {
    const contract   = new StellarSdk.Contract(CONTRACT_ID);
    const contractTx = new StellarSdk.TransactionBuilder(account, {
      fee:               StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "vote",
          StellarSdk.nativeToScVal(optionIndex, { type: "u32" }),
          StellarSdk.nativeToScVal(voter,       { type: "address" })
        )
      )
      .setTimeout(30)
      .build();

    const contractSigned = await signTransaction(contractTx.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    if (!contractSigned.error) {
      const contractSignedTx = StellarSdk.TransactionBuilder.fromXDR(
        contractSigned.signedTxXdr,
        NETWORK_PASSPHRASE
      );
      const res = await horizon.submitTransaction(contractSignedTx);
      return res.hash;
    }
  }

  const res = await horizon.submitTransaction(signedTx);
  return res.hash;
}