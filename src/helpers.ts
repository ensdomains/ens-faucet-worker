export const corsHeaders = {
  "Access-Control-Allow-Origin": "https://alpha.ens.domains",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const makeResponseFunc = (origin: string) => ({
  makeResponse: _makeResponse(origin),
  makeRpcResponse: _makeRpcResponse(origin),
});

const _makeResponse =
  (origin: string) =>
  (
    body?: BodyInit | null,
    status?: number,
    headers?: Record<string, any>,
    bypassStringify?: boolean
  ) => {
    const usedCors = { ...corsHeaders };
    if (origin === "http://localhost:3000") {
      usedCors["Access-Control-Allow-Origin"] = "http://localhost:3000";
    } else if (
      origin.endsWith("ens-app-v3.pages.dev") ||
      origin.endsWith("ens.domains")
    ) {
      usedCors["Access-Control-Allow-Origin"] = origin;
    }

    return new Response(
      typeof body === "string" && !bypassStringify
        ? JSON.stringify({ message: body })
        : body,
      {
        status,
        headers: {
          ...usedCors,
          ...(headers || {}),
        },
      }
    );
  };

const _makeRpcResponse =
  (origin: string) =>
  (body: object, id: string | number | null = null, status?: number) => {
    return _makeResponse(origin)(
      JSON.stringify({ jsonrpc: "2.0", ...body, id }),
      status,
      undefined,
      true
    );
  };
