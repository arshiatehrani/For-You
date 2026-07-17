/**
 * Cloudflare Worker — Telegram proxy + automatic Google Calendar event for the Date Night page.
 *
 * This is NOT part of the website. Copy its contents into your Cloudflare Worker
 * (dash.cloudflare.com -> Workers & Pages -> your Worker -> Edit code), then set these
 * secret variables in the Worker's Settings -> Variables and Secrets:
 *
 *   Required (Telegram):
 *     BOT_TOKEN              your bot token from @BotFather
 *     CHAT_ID                your personal chat id from @userinfobot
 *
 *   Optional (auto add-to-calendar). If these are absent, the calendar step is simply
 *   skipped and only Telegram fires:
 *     GOOGLE_CLIENT_ID       OAuth client id      (from Google Cloud Console)
 *     GOOGLE_CLIENT_SECRET   OAuth client secret  (from Google Cloud Console)
 *     GOOGLE_REFRESH_TOKEN   refresh token        (from the OAuth Playground)
 *     EVENT_TIMEZONE         optional, defaults to "America/Toronto"
 *
 * Every secret stays inside Cloudflare — never in the repo or the webpage.
 */
export default {
  async fetch(request, env) {
    const p = new URL(request.url).searchParams;
    let text = p.get("text") || "New date response ❤️";

    // --- Approximate visitor location from Cloudflare's edge geo (city-level) ---
    const cf = request.cf || {};
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const parts = [cf.city, cf.region, cf.country].filter(Boolean).join(", ") || "unknown";
    let loc = `\n\n📍 Approx. location (from IP): ${parts}`;
    if (cf.postalCode) loc += `\n🏷️ Postal: ${cf.postalCode}`;
    if (cf.latitude && cf.longitude) {
      loc += `\n🗺️ ~${cf.latitude}, ${cf.longitude}` +
             `\n   Map: https://maps.google.com/?q=${cf.latitude},${cf.longitude}`;
    }
    if (cf.timezone) loc += `\n🕰️ IP timezone: ${cf.timezone}`;
    loc += `\n🌐 IP: ${ip}`;
    text += loc;

    const tgSend = (msg) => fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.CHAT_ID, text: msg, disable_web_page_preview: true })
    });

    // --- 1) Telegram message (always) ---
    let telegramOk = false;
    try { telegramOk = (await tgSend(text)).ok; } catch (e) { telegramOk = false; }

    // --- 2) Auto-create the event on your Google Calendar (only if configured) ---
    let calendarOk = null; // null = not configured / not attempted
    const evTitle = p.get("evTitle");
    const evStart = p.get("evStart"); // "YYYY-MM-DDTHH:MM:SS" (local clock time)
    const evEnd = p.get("evEnd");

    if (env.GOOGLE_REFRESH_TOKEN && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && evTitle && evStart && evEnd) {
      calendarOk = false;
      try {
        // a) Exchange the long-lived refresh token for a short-lived access token.
        const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            refresh_token: env.GOOGLE_REFRESH_TOKEN,
            grant_type: "refresh_token"
          })
        });
        const tok = await tokenResp.json();

        if (tok.access_token) {
          // b) Insert the event on your primary calendar.
          const tz = env.EVENT_TIMEZONE || "America/Toronto";
          const event = {
            summary: evTitle,
            location: p.get("evLoc") || "Kingston, Ontario",
            description: p.get("evDesc") || "",
            start: { dateTime: evStart, timeZone: tz },
            end: { dateTime: evEnd, timeZone: tz }
          };
          const calResp = await fetch(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${tok.access_token}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify(event)
            }
          );
          calendarOk = calResp.ok;
          if (!calResp.ok) {
            const err = await calResp.text();
            try { await tgSend(`⚠️ Calendar add failed: ${err.slice(0, 300)}`); } catch (e) {}
          }
        } else {
          try { await tgSend(`⚠️ Google token error: ${JSON.stringify(tok).slice(0, 300)}`); } catch (e) {}
        }
      } catch (e) {
        calendarOk = false;
      }
    }

    return new Response(JSON.stringify({ telegramOk, calendarOk }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
};
