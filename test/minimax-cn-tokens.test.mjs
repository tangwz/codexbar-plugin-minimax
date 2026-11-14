import fs from "node:fs";
import vm from "node:vm";

const path = new URL("../minimax-cn-tokens.js", import.meta.url);
const source = fs.readFileSync(path, "utf8");
const origin = "https://www.minimax.cn";
const fixedNow = "2026-07-08T01:00:00Z";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const session = (suffix = "a", group = "123456") => ({
  id: `candidate-${suffix}`,
  source: `Fixture profile ${suffix}`,
  origin,
  header: `_token=fixture-session-${suffix}; minimax_group_id_v2=${group}`,
});
const quota = (model = {}) => ({
  base_resp: { status_code: 0 },
  data: {
    current_subscribe_title: "Token Plan Plus",
    model_remains: [
      {
        model_name: "general",
        current_interval_remaining_percent: "96",
        current_weekly_remaining_percent: "99",
        start_time: 1783472400000,
        end_time: 1783490400000,
        ...model,
      },
    ],
  },
});
const history = (
  days = [
    {
      date: "2026-07-08",
      total_token: 1200,
      total_input_token: 1000,
      total_output_token: 200,
      total_cache_read_token: 400,
      total_cache_create_token: 20,
    },
  ],
) => ({
  base_resp: { status_code: 0 },
  date_model_usage: days,
  last_update_time: "2026-07-08 09:00:00",
});
const response = (payload, status = 200) => ({
  status,
  url: origin,
  headers: {},
  bodyText: JSON.stringify(payload),
});
const row = (result, name) =>
  result.details.flatMap((section) => section.rows).find((entry) => entry.label === name)?.value;

function harness(options = {}) {
  let definition;
  vm.runInNewContext(
    source,
    {
      defineProvider: (value) => {
        definition = value;
      },
    },
    { filename: "minimax-cn-tokens.js" },
  );
  const calls = [];
  const accepted = [];
  const rejected = [];
  let visited = 0;
  const failures = Object.fromEntries(
    [
      "authenticationExpired",
      "missingCredential",
      "permissionDenied",
      "rateLimited",
      "providerUnavailable",
      "parseFailure",
      "networkFailure",
      "apiFailure",
    ].map((category) => [category, (message) => Object.assign(new Error(message), { category })]),
  );
  const ctx = {
    env: options.env,
    date: { now: () => new Date(options.now || fixedNow) },
    fail: failures,
    log: () => {
      throw new Error("The plugin must not log session material.");
    },
    browser: {
      availability: () => (options.off ? "off" : "available"),
      async *sessions() {
        for (const candidate of options.sessions || [session()]) {
          visited++;
          yield candidate;
        }
      },
      acceptCookie: () => {
        throw new Error("User plugins cannot persist browser sessions.");
      },
      rejectCookie: (_domain, candidate) => rejected.push(candidate.id),
    },
    http: {
      async get(url, request) {
        check(
          url === `${origin}/backend/account/token_plan/remains_percent` ||
            url === `${origin}/backend/account/token_plan/usage_summary`,
          "Only fixed MiniMax China endpoints are allowed.",
        );
        calls.push({ url, request });
        if (options.request) return options.request(url, request, calls.length);
        if (url.endsWith("usage_summary"))
          return options.historyResponse || response(options.history || history());
        return options.quotaResponse || response(options.quota || quota());
      },
    },
  };
  return {
    definition,
    calls,
    accepted,
    rejected,
    visited: () => visited,
    run: () => definition.fetchUsage(ctx),
  };
}

const tests = [];
const test = (name, operation) => tests.push({ name, operation });
const expectFailure = async (operation, category) => {
  try {
    await operation();
  } catch (error) {
    check(error.category === category, "Unexpected sanitized failure category.");
    return;
  }
  throw new Error("Expected a failure.");
};

test("manifest is standalone, fixed-origin, and has no persistent credential settings", () => {
  const { definition } = harness();
  check(definition.id === "minimax-cn-tokens", "Wrong plugin identity.");
  check(
    definition.endpoints.length === 1 && definition.endpoints[0] === origin,
    "Unexpected network authority.",
  );
  check(
    definition.cookieDomains.length === 1 && definition.cookieDomains[0] === "www.minimax.cn",
    "Unexpected cookie authority.",
  );
  check(
    definition.settings.length === 0 && !definition.capabilities.includes("persistent-storage"),
    "Credentials must not be persisted.",
  );
});

test("supported hosts use built-in MiniMax branding", async () => {
  const result = await harness({ env: { supportsIconProvider: true } }).run();
  check(result.iconProvider === "minimax", "Built-in MiniMax branding was not selected.");
});

test("legacy hosts omit unsupported snapshot branding", async () => {
  for (const env of [
    undefined,
    {},
    { supportsIconProvider: false },
    { supportsIconProvider: "true" },
  ]) {
    const result = await harness({ env }).run();
    check(
      !Object.prototype.hasOwnProperty.call(result, "iconProvider"),
      "An unsupported snapshot field would break legacy fetches.",
    );
  }
});

test("quota and token statistics use the same complete session", async () => {
  const h = harness();
  const result = await h.run();
  check(
    h.calls.length === 2 &&
      h.calls[0].url.endsWith("remains_percent") &&
      h.calls[1].url.endsWith("usage_summary"),
    "Required quota must precede optional history.",
  );
  check(
    h.calls.every(
      (call) =>
        call.request.headers.Cookie === session().header &&
        call.request.headers["X-Group-Id"] === "123456",
    ),
    "Session/group binding changed.",
  );
  check(
    result.primary.usedPercent === 4 && result.secondary.usedPercent === 1,
    "Quota percentages changed.",
  );
  check(
    row(result, "Today tokens") === "1,200" && row(result, "Input tokens") === "1,000",
    "Token totals changed.",
  );
  check(
    row(result, "Cache read tokens") === "400" && row(result, "30d tokens") === "1,200",
    "Cache subsets must not be added.",
  );
  check(
    result.details[1].chart.points.length === 1 && h.accepted.length === 0,
    "A valid session must publish a chart.",
  );
  check(
    !JSON.stringify(result).includes("fixture-session") &&
      !JSON.stringify(result).includes("123456"),
    "Credentials or group leaked to usage.",
  );
});

test("remaining counts are not misinterpreted as used counts", async () => {
  const model = {
    current_interval_remaining_percent: null,
    current_weekly_remaining_percent: null,
    current_interval_total_count: 1000,
    current_interval_usage_count: 250,
    current_weekly_total_count: 2000,
    current_weekly_usage_count: 1500,
  };
  const result = await harness({ quota: quota(model) }).run();
  check(
    result.primary.usedPercent === 75 && result.secondary.usedPercent === 25,
    "Remaining quota semantics changed.",
  );
});

test("boosted used percentages normalize against the reported allowance", async () => {
  const model = {
    current_interval_remaining_percent: null,
    current_interval_used_percent: "30%",
    current_interval_total_percent: "200%",
  };
  check(
    (await harness({ quota: quota(model) }).run()).primary.usedPercent === 15,
    "Boosted quota normalization changed.",
  );
});

test("explicit unlimited quotas remain labeled as unlimited", async () => {
  const result = await harness({
    quota: quota({ current_interval_status: 3, current_interval_used_percent: 0 }),
  }).run();
  check(
    result.primary.resetDescription === "Unlimited" && row(result, "5-hour quota") === "Unlimited",
    "Unlimited quota must be explicit.",
  );
});

test("non-text models are never substituted for text quotas", async () => {
  const payload = quota();
  payload.data.model_remains.unshift({
    model_name: "video",
    current_interval_remaining_percent: 0,
  });
  check(
    (await harness({ quota: payload }).run()).primary.usedPercent === 4,
    "Video quota was substituted.",
  );
});

test("missing group and cross-origin candidates make no requests", async () => {
  const incomplete = { ...session(), header: "_token=fixture-incomplete" };
  const foreign = { ...session(), origin: "https://www.minimaxi.com" };
  const h = harness({ sessions: [incomplete, foreign] });
  await expectFailure(() => h.run(), "missingCredential");
  check(h.calls.length === 0, "Incomplete or foreign sessions reached the provider.");
});

test("ambiguous group cookies are not guessed", async () => {
  const candidate = { ...session(), header: `${session().header}; minimax_group_id_v2=654321` };
  const h = harness({ sessions: [candidate] });
  await expectFailure(() => h.run(), "missingCredential");
  check(h.calls.length === 0, "Ambiguous group was used.");
});

test("authentication failures advance once and stop at the first validated session", async () => {
  const h = harness({
    sessions: [session("a"), session("b", "654321"), session("c")],
    request: (_url, request, index) => {
      if (index === 1) return response({}, 401);
      check(
        request.headers.Cookie === session("b", "654321").header &&
          request.headers["X-Group-Id"] === "654321",
        "Candidates were mixed.",
      );
      return index === 2 ? response(quota()) : response(history());
    },
  });
  await h.run();
  check(
    h.visited() === 2 && h.rejected.length === 1 && h.accepted.length === 0,
    "Session traversal policy changed.",
  );
});

test("business authentication errors are recognized before quota parsing", async () => {
  const h = harness({
    quotaResponse: response({ base_resp: { status_code: 1004, status_msg: "login required" } }),
  });
  await expectFailure(() => h.run(), "authenticationExpired");
  check(h.rejected.length === 1 && h.calls.length === 1, "Authentication recovery did not run.");
});

for (const status of [401, 403, 404, 500])
  test(`optional history HTTP ${status} retains valid quota`, async () => {
    const h = harness({ historyResponse: response({}, status) });
    const result = await h.run();
    check(
      result.primary.usedPercent === 4 &&
        row(result, "Status") === "Unavailable" &&
        h.rejected.length === 0,
      "Optional history discarded quota.",
    );
  });

test("optional schema and transport failures retain valid quota", async () => {
  for (const mode of ["schema", "network"]) {
    const h = harness({
      request: (url) => {
        if (!url.endsWith("usage_summary")) return response(quota());
        if (mode === "network") throw { transportClass: "timeout", transportCode: -1001 };
        return response({ date_model_usage: {} });
      },
    });
    const result = await h.run();
    check(
      result.primary && row(result, "Status") === "Unavailable",
      "Optional failure was not contained.",
    );
  }
});

test("cancellation is propagated instead of publishing stale quota", async () => {
  const cancellation = { transportClass: "cancelled", transportCode: -999 };
  const h = harness({
    request: (url) => {
      if (url.endsWith("usage_summary")) throw cancellation;
      return response(quota());
    },
  });
  let observed;
  try {
    await h.run();
  } catch (error) {
    observed = error;
  }
  check(observed === cancellation && h.accepted.length === 0, "Cancellation was swallowed.");
});

test("quota network failures retain credentials and do not try another account", async () => {
  const h = harness({
    sessions: [session("a"), session("b")],
    request: () => {
      throw { transportClass: "timeout" };
    },
  });
  await expectFailure(() => h.run(), "networkFailure");
  check(
    h.calls.length === 1 && h.rejected.length === 0 && h.visited() === 1,
    "Network errors changed session selection.",
  );
});

test("Off never reads browser sessions", async () => {
  const h = harness({ off: true });
  await expectFailure(() => h.run(), "missingCredential");
  check(h.visited() === 0 && h.calls.length === 0, "Off policy was bypassed.");
});

test("China calendar date is independent of UTC", async () => {
  const result = await harness({
    now: "2026-07-07T17:00:00Z",
    history: history([
      { date: "2026-07-07", total_token: 20 },
      { date: "2026-07-08", total_token: 10 },
    ]),
  }).run();
  check(
    row(result, "Today tokens") === "10" && row(result, "30d tokens") === "30",
    "China day boundary changed.",
  );
});

test("latest reported day and update time are not substituted for today", async () => {
  const result = await harness({
    history: history([{ date: "2026-07-07", total_token: 10 }]),
  }).run();
  check(
    row(result, "Today tokens") === "\u2014" && row(result, "30d tokens") === "10",
    "A stale day became today.",
  );
});

test("zero counts are preserved and absent totals are not reconstructed", async () => {
  const zero = await harness({ history: history([{ date: "2026-07-08", total_token: 0 }]) }).run();
  check(row(zero, "Today tokens") === "0", "Known zero disappeared.");
  const absent = await harness({
    history: history([{ date: "2026-07-08", total_input_token: 10, total_output_token: 20 }]),
  }).run();
  check(
    row(absent, "Today tokens") === "\u2014" && row(absent, "30d tokens") === "\u2014",
    "Missing total was invented.",
  );
});

test("integer strings and raw JSON integers remain exact above double precision", async () => {
  const body = '{"date_model_usage":[{"date":"2026-07-08","total_token":9223372036854775807}]}';
  const result = await harness({ historyResponse: { status: 200, bodyText: body } }).run();
  check(
    row(result, "Today tokens") === "9,223,372,036,854,775,807",
    "Raw JSON integer was rounded.",
  );
  const overflow = await harness({
    history: history([
      { date: "2026-07-08", total_token: "9223372036854775807" },
      { date: "2026-07-07", total_token: 1 },
    ]),
  }).run();
  check(
    row(overflow, "30d tokens") === "\u2014",
    "Aggregate overflow was reported as a valid total.",
  );
});

test("conflicting days remain unknown and identical duplicates do not inflate totals", async () => {
  const duplicate = await harness({
    history: history([
      { date: "2026-07-08", total_token: 10 },
      { date: "2026-07-08", total_token: 10 },
    ]),
  }).run();
  check(row(duplicate, "30d tokens") === "10", "Duplicate day was counted twice.");
  const conflict = await harness({
    history: history([
      { date: "2026-07-08", total_token: 10 },
      { date: "2026-07-08", total_token: 20 },
    ]),
  }).run();
  check(
    row(conflict, "Today tokens") === "\u2014" && row(conflict, "30d tokens") === "\u2014",
    "Conflicting data was understated.",
  );
});

test("invalid, future, and outside-window dates do not invent chart bars", async () => {
  const result = await harness({
    history: history([
      { date: "2026-02-30", total_token: 100 },
      { date: "2026-07-09", total_token: 100 },
      { date: "2026-06-08", total_token: 100 },
      { date: "2026-06-09", total_token: 1 },
    ]),
  }).run();
  check(
    row(result, "30d tokens") === "1" && result.details[1].chart.points.length === 1,
    "Calendar bounds changed.",
  );
});

test("malformed JSON is never made valid by number preservation", async () => {
  const h = harness({ quotaResponse: { status: 200, bodyText: "{123:1}" } });
  await expectFailure(() => h.run(), "parseFailure");
  check(h.calls.length === 1, "Invalid quota was used for history.");
});

test("structured history is capability gated and preserves server token semantics", async () => {
  for (const env of [undefined, {}, { supportsCostUsageV2: false }]) {
    check(!(await harness({ env }).run()).costUsage, "Old hosts received new history fields.");
  }
  const result = await harness({ env: { supportsCostUsageV2: true } }).run();
  const usage = result.costUsage;
  check(usage.version === 2 && usage.timeZone === "Asia/Shanghai", "Missing protocol or calendar.");
  check(usage.windowStart === "2026-06-09" && usage.windowEnd === "2026-07-08", "Wrong window.");
  check(usage.entries.length === 1 && usage.entries[0].totalTokens === "1200", "Fabricated daily coverage.");
  check(usage.entries[0].inputTokens === "1000" && usage.entries[0].cacheReadTokens === "400", "Cache was added twice.");
  check(!("currency" in usage) && !("cost" in usage.entries[0]) && !("requests" in usage.entries[0]), "Unknown metrics were invented.");
});

test("structured history retains exact counts and omits overflowing history", async () => {
  const exact = await harness({
    env: { supportsCostUsageV2: true },
    history: history([{ date: "2026-07-08", total_token: "9007199254740993" }]),
  }).run();
  check(exact.costUsage.entries[0].totalTokens === "9007199254740993", "Integer precision was lost.");
  const overflow = await harness({
    env: { supportsCostUsageV2: true },
    history: history([
      { date: "2026-07-07", total_token: "9223372036854775807" },
      { date: "2026-07-08", total_token: "1" },
    ]),
  }).run();
  check(!overflow.costUsage && overflow.primary, "An overflowing history could fail the quota snapshot.");
});

for (const { name, operation } of tests) {
  try {
    await operation();
    console.log(`PASS ${name}`);
  } catch {
    console.error(`FAIL ${name}`);
    process.exit(1);
  }
}
console.log(`${tests.length} offline checks passed; no browser or network access used.`);
