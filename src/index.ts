import { Relayer } from "defender-relay-client/lib/relayer";
import { makeResponseFunc } from "./helpers";

export interface Env {
  USED_ADDRESS_KV: KVNamespace;
  RELAYER_KEY: string;
  RELAYER_SECRET: string;
}

type JsonRPC = {
  jsonrpc: string;
  id: string | number | null;
  method: string;
  params: any;
};

type BaseJsonRPCResponse = {
  jsonrpc: string;
  id: string | number | null;
  result: string;
};

const CLAIM_INTERVAL = 1000 * 60 * 60 * 24 * 90;
const CLAIM_AMOUNT = 250000000000000000n; // 0.25 ETH
const SUPPORTED_METHODS = [
  "faucet_status",
  "faucet_getAddress",
  "faucet_request",
];

const query = (method: string, params: any) =>
  fetch("https://web3.ens.domains/v1/goerli", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  }).then((res) => res.json<BaseJsonRPCResponse>());

type DomainArray = { id: string }[];

// check mainnet for if address has ownership of a name
const checkHasName = async (address: string) => {
  const gqlQuery = `{
    account(id: "${address.toLowerCase()}") {
      domains(first: 1) {
        id
      }
      registrations(first: 1) {
        id
      }
      wrappedDomains(first: 1) {
        id
      }
    }
  }`;
  const data = await fetch(
    "https://api.thegraph.com/subgraphs/name/ensdomains/ens",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: gqlQuery }),
    }
  ).then((res) =>
    res.json<{
      data?: {
        account?: {
          domains: DomainArray;
          registrations: DomainArray;
          wrappedDomains: DomainArray;
        };
      };
    }>()
  );

  if (!data?.data?.account) return false;

  const { domains, registrations, wrappedDomains } = data.data.account;

  return (
    domains.length > 0 || registrations.length > 0 || wrappedDomains.length > 0
  );
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    const { makeResponse, makeRpcResponse } = makeResponseFunc(
      request.headers.get("origin") || ""
    );

    const paths = url.pathname.split("/").filter((p) => p);

    if (paths.length !== 0) {
      return makeResponse("Not Found", 404);
    }

    if (request.method === "OPTIONS") {
      return makeResponse(null);
    }

    if (request.method !== "POST") {
      return makeResponse(`Unsupported method: ${request.method}`, 405);
    }

    const body = await request.json<JsonRPC>().catch(() => null);

    if (!body || !body.jsonrpc || !body.method || !body.params) {
      return makeRpcResponse(
        { error: { code: -32600, message: "Invalid Request" } },
        body?.id,
        400
      );
    }

    if (!SUPPORTED_METHODS.includes(body.method)) {
      return makeRpcResponse(
        { error: { code: -32601, message: "Method not found" } },
        body.id,
        404
      );
    }

    const relayer = new Relayer({
      apiKey: env.RELAYER_KEY,
      apiSecret: env.RELAYER_SECRET,
    });
    const item = await relayer.getRelayer();
    const returnOnStatusChange = body.method === "faucet_status";
    let status = "ok";

    const returnStatus = () => makeRpcResponse({ result: { status } }, body.id);

    if (item.paused) {
      status = "paused";
      if (returnOnStatusChange) returnStatus();
    }

    const balanceResponse = await query("eth_getBalance", [
      item.address,
      "latest",
    ]);
    const balance = BigInt(balanceResponse.result);
    if (CLAIM_AMOUNT > balance) {
      status = "out of funds";
      if (returnOnStatusChange) returnStatus();
    }

    if (returnOnStatusChange) returnStatus();

    const address = body.params[0];

    if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
      return makeRpcResponse(
        { error: { code: -32000, message: "Invalid address" } },
        body.id,
        400
      );
    }

    const addressLowerCase = address.toLowerCase();
    const addressLastUsedLowerCase = await env.USED_ADDRESS_KV.get(addressLowerCase);
    const addressLastUsed = addressLastUsedLowerCase || (addressLowerCase === address ? null : await env.USED_ADDRESS_KV.get(address));

    const hasClaimed =
      addressLastUsed &&
      Date.now() - parseInt(addressLastUsed) < CLAIM_INTERVAL;
    const hasName = await checkHasName(address);

    if (body.method === "faucet_getAddress") {
      if (hasClaimed) {
        return makeRpcResponse(
          {
            result: {
              eligible: false,
              next: addressLastUsed + CLAIM_INTERVAL,
              status,
            },
          },
          body.id
        );
      }
      return makeRpcResponse(
        { result: { eligible: hasName, next: 0, status } },
        body.id
      );
    }

    // return for faucet_request

    if (hasClaimed) {
      return makeRpcResponse(
        { error: { code: -32000, message: "Address has already claimed" } },
        body.id,
        400
      );
    }

    if (!hasName) {
      return makeRpcResponse(
        {
          error: {
            code: -32000,
            message: "Address does not own a name on mainnet",
          },
        },
        body.id,
        400
      );
    }

    if (status !== "ok") {
      return makeRpcResponse(
        { error: { code: -32000, message: `Faucet error: ${status}` } },
        body.id,
        400
      );
    }

    const tx = await relayer.sendTransaction({
      to: address,
      value: "0x" + CLAIM_AMOUNT.toString(16),
      speed: "fast",
      gasLimit: 21000,
    });

    if (!tx.transactionId) {
      return makeRpcResponse(
        { error: { code: -32000, message: "Transaction failed" } },
        body.id,
        400
      );
    }

    await env.USED_ADDRESS_KV.put(body.params[0], Date.now().toString());

    return makeRpcResponse({ result: { id: tx.transactionId } }, body.id);
  },
};
