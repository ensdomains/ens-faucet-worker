import { Relayer } from "defender-relay-client/lib/relayer";
import { Address, getAddress, toHex } from "viem";
import { makeResponseFunc } from "./helpers";

export interface Env {
  USED_ADDRESS_KV: KVNamespace;
  RELAYER_AUTH: string;
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

const SUPPORTED_METHODS = [
  "faucet_status",
  "faucet_getAddress",
  "faucet_request",
] as const;
const SUPPORTED_NETWORKS = ["goerli", "sepolia"] as const;

const CLAIM_INTERVAL_MAP: Record<SupportedNetwork, number> = {
  goerli: 1000 * 60 * 60 * 24 * 7, // 1 week
  sepolia: 1000 * 60 * 60 * 24 * 30, // 1 month
};

const CLAIM_AMOUNT_MAP: Record<SupportedNetwork, bigint> = {
  goerli: 500000000000000000n, // 0.5 ETH
  sepolia: 250000000000000000n, // 0.25 ETH
};

type SupportedMethod = (typeof SUPPORTED_METHODS)[number];
type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number];

const query = ({
  network,
  method,
  params,
}: {
  network: SupportedNetwork;
  method: string;
  params: any[];
}) =>
  fetch(`https://web3.ens.domains/v1/${network}`, {
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

    const network =
      paths.length === 0
        ? "goerli"
        : SUPPORTED_NETWORKS.find((n) => n === paths[0]);
    if (!network) return makeResponse("Not Found", 404);

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

    if (!SUPPORTED_METHODS.includes(body.method as SupportedMethod)) {
      return makeRpcResponse(
        { error: { code: -32601, message: "Method not found" } },
        body.id,
        404
      );
    }

    const { apiKey, apiSecret } = JSON.parse(env.RELAYER_AUTH)[network];
    const claimAmount = CLAIM_AMOUNT_MAP[network];
    const claimInterval = CLAIM_INTERVAL_MAP[network];

    const relayer = new Relayer({
      apiKey,
      apiSecret,
    });
    const item = await relayer.getRelayer();
    const returnOnStatusChange = body.method === "faucet_status";
    let status = "ok";

    const returnStatus = () =>
      makeRpcResponse(
        {
          result: {
            status,
            amount: toHex(claimAmount),
            interval: claimInterval,
          },
        },
        body.id
      );

    if (item.paused) {
      status = "paused";
      if (returnOnStatusChange) returnStatus();
    }

    const balanceResponse = await query({
      network,
      method: "eth_getBalance",
      params: [item.address, "latest"],
    });
    const balance = BigInt(balanceResponse.result);

    if (claimAmount > balance) {
      status = "out of funds";
      if (returnOnStatusChange) returnStatus();
    }

    if (returnOnStatusChange) returnStatus();

    let address: Address;
    try {
      address = getAddress(body.params[0]);
    } catch {
      return makeRpcResponse(
        { error: { code: -32000, message: "Invalid address" } },
        body.id,
        400
      );
    }

    const key = `${network}/${address}`;

    const addressLastUsed = await env.USED_ADDRESS_KV.get(key).then((v) =>
      v ? parseInt(v, 10) : 0
    );
    // the KV data should be expired if the claim interval has passed
    // but this is just a safety check
    const hasClaimed =
      addressLastUsed && Date.now() - addressLastUsed < claimInterval;

    const hasName = await checkHasName(address);

    if (body.method === "faucet_getAddress") {
      if (hasClaimed) {
        return makeRpcResponse(
          {
            result: {
              eligible: false,
              amount: toHex(claimAmount),
              interval: claimInterval,
              next: addressLastUsed + claimInterval,
              status,
            },
          },
          body.id
        );
      }
      return makeRpcResponse(
        {
          result: {
            eligible: hasName,
            amount: toHex(claimAmount),
            interval: claimInterval,
            next: 0,
            status,
          },
        },
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
      value: toHex(claimAmount),
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

    // record address as used
    // will "expire" (delete) after claimInterval
    await env.USED_ADDRESS_KV.put(key, Date.now().toString(), {
      // expirationTtl is in seconds
      expirationTtl: Math.floor(claimInterval / 1000),
    });

    return makeRpcResponse({ result: { id: tx.transactionId } }, body.id);
  },
};
