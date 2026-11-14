// MiniMax China Coding Plan: browser-cookie quota and provider-reported token history.
// Credentials remain in the current host-issued browser session and are never persisted or logged.
defineProvider({
  id: "minimax-cn-tokens",
  name: "MiniMax CN Tokens",
  icon: { monogram: "MM", tint: "#FE603C" },
  endpoints: ["https://www.minimax.cn"],
  settings: [],
  capabilities: ["browser-cookies", "http-status"],
  cookieDomains: ["www.minimax.cn"],

  async fetchUsage(ctx) {
    const domain = "www.minimax.cn";
    const origin = `https://${domain}`;
    const quotaURL = `${origin}/backend/account/token_plan/remains_percent`;
    const historyURL = `${origin}/backend/account/token_plan/usage_summary`;
    const maxCount = 9223372036854775807n;
    const dayMillis = 86400000;
    const now = ctx.date.now();
    const cancelled = (error) =>
      error && (error.transportClass === "cancelled" || error.transportCode === -999);
    const rejected = ctx.fail.authenticationExpired(
      "MiniMax China rejected the browser session. Sign in again and refresh.",
    );
    const invalid = () =>
      ctx.fail.parseFailure(
        "MiniMax China returned an unsupported response. No usage was inferred.",
      );
    const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const boundedText = (value, maximum = 80) =>
      typeof value === "string"
        ? value
            .replace(/[\x00-\x1f\x7f]/g, "")
            .trim()
            .slice(0, maximum)
        : "";

    // Validate JSON syntax first, then retain number lexemes before JavaScript can round integers.
    const exactJSON = (body) => {
      if (typeof body !== "string") throw invalid();
      try {
        JSON.parse(body);
        let output = "";
        let index = 0;
        while (index < body.length) {
          if (body[index] === '"') {
            const start = index++;
            while (index < body.length) {
              const character = body[index++];
              if (character === "\\") index++;
              else if (character === '"') break;
            }
            output += body.slice(start, index);
          } else if (body[index] === "-" || /[0-9]/.test(body[index])) {
            const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
              body.slice(index),
            );
            if (!match) throw invalid();
            output += JSON.stringify(match[0]);
            index += match[0].length;
          } else {
            output += body[index++];
          }
        }
        return JSON.parse(output);
      } catch {
        throw invalid();
      }
    };
    const number = (value) => {
      if (typeof value !== "number" && typeof value !== "string") return null;
      const text = String(value).trim().replace(/%$/, "");
      if (!text) return null;
      const result = Number(text);
      return Number.isFinite(result) ? result : null;
    };
    const count = (value) => {
      if (typeof value !== "string" || !/^\+?[0-9]+$/.test(value.trim())) return null;
      try {
        const result = BigInt(value.trim());
        return result <= maxCount ? result : null;
      } catch {
        return null;
      }
    };
    const display = (value) =>
      value === null ? "\u2014" : value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const statusOf = (payload) => {
      for (const candidate of [
        payload && payload.base_resp,
        payload && payload.data && payload.data.base_resp,
      ]) {
        if (!object(candidate)) continue;
        const code = number(candidate.status_code);
        if (code !== null && code !== 0) {
          const message =
            typeof candidate.status_msg === "string" ? candidate.status_msg.toLowerCase() : "";
          if (
            code === 1004 ||
            /cookie|log\s*in|sign\s*in/.test(message) ||
            message.trim() === "invalid api key"
          )
            throw rejected;
          throw ctx.fail.apiFailure("MiniMax China reported an API error.");
        }
      }
    };
    const checkResponse = (response) => {
      if (response.status === 401 || response.status === 403) throw rejected;
      if (response.status === 429)
        throw ctx.fail.rateLimited("MiniMax China is rate limited. Try again later.");
      if (response.status >= 500)
        throw ctx.fail.providerUnavailable("MiniMax China is temporarily unavailable.");
      if (response.status !== 200)
        throw ctx.fail.apiFailure(`MiniMax China returned HTTP ${response.status}.`);
      if (
        typeof response.bodyText === "string" &&
        /<html|<!doctype/i.test(response.bodyText) &&
        /log\s*in|sign\s*in|\u767b\u5f55/i.test(response.bodyText)
      )
        throw rejected;
      const payload = exactJSON(response.bodyText);
      if (!object(payload)) throw invalid();
      statusOf(payload);
      return payload;
    };
    const sessionCredentials = (session) => {
      const header = session && session.header;
      if (
        !session ||
        session.origin !== origin ||
        typeof header !== "string" ||
        !header ||
        header.length > 65536 ||
        /[\x00-\x1f\x7f]/.test(header)
      )
        return null;
      const selected = { _token: [], minimax_group_id_v2: [] };
      for (const part of header.split(";")) {
        const separator = part.indexOf("=");
        if (separator < 1) continue;
        const name = part.slice(0, separator).trim();
        if (!Object.prototype.hasOwnProperty.call(selected, name)) continue;
        let value = part.slice(separator + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        selected[name].push(value);
      }
      const tokenValues = [...new Set(selected._token)];
      const groupValues = [...new Set(selected.minimax_group_id_v2)];
      if (
        tokenValues.length !== 1 ||
        !tokenValues[0] ||
        /^(?:null|undefined)$/i.test(tokenValues[0]) ||
        groupValues.length !== 1
      )
        return null;
      let group;
      try {
        group = decodeURIComponent(groupValues[0]);
      } catch {
        return null;
      }
      if (!/^[0-9]{4,64}$/.test(group)) return null;
      return { header, group };
    };
    const epoch = (value) => {
      const raw = number(value);
      if (raw === null || raw <= 1000000000) return null;
      const date = new Date(raw > 1000000000000 ? raw : raw * 1000);
      return Number.isFinite(date.getTime()) ? date : null;
    };
    const quotaLane = (model, weekly) => {
      const prefix = weekly ? "current_weekly_" : "current_interval_";
      const status = number(model[`${prefix}status`]);
      const total = count(model[`${prefix}total_count`]);
      const remaining = count(model[`${prefix}usage_count`]);
      const remainingPercent = number(model[`${prefix}remaining_percent`]);
      const used = number(model[`${prefix}used_percent`]);
      const totalPercent = number(model[`${prefix}total_percent`]);
      const unlimited =
        status === 3 &&
        (used !== null || (weekly && remainingPercent !== null && remainingPercent >= 100));
      let percent;
      if (unlimited) percent = 0;
      else if (remainingPercent !== null && remainingPercent >= 0) percent = 100 - remainingPercent;
      else if (used !== null && used >= 0 && (totalPercent === null || totalPercent >= 0))
        percent = (used / (totalPercent || 100)) * 100;
      else if (total !== null && total > 0n && remaining !== null)
        percent = (Number(total > remaining ? total - remaining : 0n) / Number(total)) * 100;
      else return null;
      percent = Math.max(0, Math.min(100, percent));
      const start = epoch(model[weekly ? "weekly_start_time" : "start_time"]);
      const end = epoch(model[weekly ? "weekly_end_time" : "end_time"]);
      const minutes =
        start && end && end > start ? Math.round((end - start) / 60000) : weekly ? 10080 : 300;
      const title = weekly ? "Weekly quota" : minutes === 300 ? "5-hour quota" : "Session quota";
      const window = {
        title: unlimited ? `${title} (unlimited)` : title,
        usedPercent: percent,
        windowMinutes: minutes,
      };
      if (end && end > now) window.resetsAt = end.toISOString();
      if (unlimited) window.resetDescription = "Unlimited";
      const row = {
        label: title,
        value: unlimited ? "Unlimited" : `${Math.round(percent * 10) / 10}% used`,
        progress: percent / 100,
      };
      if (!unlimited && total !== null && total > 0n && remaining !== null)
        row.secondaryValue = `${display(remaining)} / ${display(total)} remaining quota units`;
      return { window, row };
    };
    const parseQuota = (payload) => {
      const data = object(payload.data) ? payload.data : payload;
      if (!Array.isArray(data.model_remains)) throw invalid();
      const models = data.model_remains.filter(
        (item) =>
          object(item) &&
          typeof item.model_name === "string" &&
          /^(?:general$|minimax-m|m2\.)/i.test(item.model_name.trim()),
      );
      const model =
        models.find((item) => item.model_name.trim().toLowerCase() === "general") || models[0];
      if (!model) throw invalid();
      const interval = quotaLane(model, false);
      const weekly = quotaLane(model, true);
      if (!interval && !weekly) throw invalid();
      const rows = [interval && interval.row, weekly && weekly.row].filter(Boolean);
      const plan = boundedText(
        data.current_subscribe_title ||
          data.plan_name ||
          data.current_plan_title ||
          data.combo_title,
      );
      if (plan) rows.unshift({ label: "Plan", value: plan });
      rows.push({ label: "Quota model", value: boundedText(model.model_name) });
      const result = {
        details: [{ title: "Coding Plan", rows }],
        identity: { loginMethod: "MiniMax China browser session" },
        dataConfidence: "percentOnly",
      };
      if (interval) result.primary = interval.window;
      if (weekly) result[interval ? "secondary" : "primary"] = weekly.window;
      return result;
    };
    const dateKey = (date) =>
      `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    const calendarDate = (key) => {
      if (typeof key !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(key)) return null;
      const [year, month, day] = key.split("-").map(Number);
      const date = new Date(0);
      date.setUTCFullYear(year, month - 1, day);
      date.setUTCHours(0, 0, 0, 0);
      return dateKey(date) === key ? date : null;
    };
    const parseHistory = (payload) => {
      const data = object(payload.data) ? payload.data : payload;
      const records = data.date_model_usage;
      if (records !== undefined && records !== null && !Array.isArray(records)) throw invalid();
      // China console days are UTC+8 calendar days, independent of the user's display timezone.
      const todayKey = dateKey(new Date(now.getTime() + 8 * 3600000));
      const today = calendarDate(todayKey);
      const startKey = dateKey(new Date(today.getTime() - 29 * dayMillis));
      const fields = [
        "total_token",
        "total_input_token",
        "total_output_token",
        "total_cache_read_token",
        "total_cache_create_token",
      ];
      const days = new Map();
      const conflicting = new Set();
      for (const record of records || []) {
        if (!object(record) || typeof record.date !== "string") continue;
        const key = record.date.trim();
        if (!calendarDate(key) || key > todayKey || key < startKey || conflicting.has(key))
          continue;
        const values = fields.map((field) => count(record[field]));
        const signature = values
          .map((value) => (value === null ? "?" : value.toString()))
          .join("|");
        const previous = days.get(key);
        if (previous && previous.signature !== signature) {
          days.set(key, { key, values: fields.map(() => null), signature: "conflict" });
          conflicting.add(key);
        } else if (!previous) days.set(key, { key, values, signature });
      }
      const ordered = [...days.values()].sort((a, b) => a.key.localeCompare(b.key));
      if (!ordered.length)
        return {
          title: "Tokens",
          rows: [
            {
              label: "History",
              value: "Not reported",
              secondaryValue: "No dated token records in the last 30 China calendar days.",
            },
          ],
        };
      const current = days.get(todayKey);
      const values = current ? current.values : fields.map(() => null);
      let total = 0n;
      for (const day of ordered) {
        if (day.values[0] === null || total === null) total = null;
        else {
          total += day.values[0];
          if (total > maxCount) total = null;
        }
      }
      const rows = [
        { label: "Today tokens", value: display(values[0]) },
        { label: "Input tokens", value: display(values[1]) },
        { label: "Output tokens", value: display(values[2]) },
        {
          label: "Cache read tokens",
          value: display(values[3]),
          secondaryValue: "Included in input tokens",
        },
        { label: "Cache write tokens", value: display(values[4]) },
        {
          label: "30d tokens",
          value: display(total),
          secondaryValue: `${ordered.length} reported days`,
        },
      ];
      const updated = boundedText(data.last_update_time, 64);
      if (updated && /^[\x20-\x7e]+$/.test(updated))
        rows.push({ label: "Data updated", value: updated });
      const points = ordered
        .filter((day) => day.values[0] !== null)
        .map((day) => ({ label: day.key, value: Number(day.values[0]) }));
      const section = { title: "Tokens", rows };
      if (points.length)
        section.chart = { kind: "bars", title: "Daily tokens", unit: "tokens", points };
      return section;
    };

    if (ctx.browser.availability(domain) === "off")
      throw ctx.fail.missingCredential("MiniMax China browser cookies are disabled.");
    let sawRejected = false;
    for await (const session of ctx.browser.sessions(domain)) {
      const credentials = sessionCredentials(session);
      if (!credentials) continue;
      const headers = {
        Cookie: credentials.header,
        "X-Group-Id": credentials.group,
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/plain, */*",
        Origin: "https://platform.minimax.cn",
        Referer: "https://platform.minimax.cn/console/usage",
      };
      let snapshot;
      try {
        let response;
        try {
          response = await ctx.http.get(quotaURL, { headers, timeoutSeconds: 12 });
        } catch (error) {
          if (cancelled(error)) throw error;
          if (error && (error.status === 401 || error.status === 403)) throw rejected;
          throw ctx.fail.networkFailure(
            "Could not reach MiniMax China. The browser session was retained.",
          );
        }
        snapshot = parseQuota(checkResponse(response));
      } catch (error) {
        if (error !== rejected) throw error;
        ctx.browser.rejectCookie(domain, session);
        sawRejected = true;
        continue;
      }
      let tokens;
      try {
        const response = await ctx.http.get(historyURL, { headers, timeoutSeconds: 5 });
        tokens = parseHistory(checkResponse(response));
        if (tokens.chart) snapshot.dataConfidence = "exact";
      } catch (error) {
        if (cancelled(error)) throw error;
        tokens = {
          title: "Tokens",
          rows: [
            {
              label: "Status",
              value: "Unavailable",
              secondaryValue: "Quota loaded; token statistics could not be retrieved.",
            },
          ],
        };
      }
      snapshot.details.push(tokens);
      // User plugins do not have the bundled-only persistent cookie acceptance capability.
      return snapshot;
    }
    if (sawRejected) throw rejected;
    throw ctx.fail.missingCredential(
      "No complete MiniMax China session found. Sign in to platform.minimax.cn and refresh. This plugin requires _token and minimax_group_id_v2 cookies from the same session.",
    );
  },
});
