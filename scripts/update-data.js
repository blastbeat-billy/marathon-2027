// ============================================================
// update-data.js  (version 2 - matches the website's DATA format)
// Fetches the latest fundraising total from People's Fundraising
// and your runs from Strava, then saves both into data.json.
// Runs automatically via GitHub Actions - NOT in the browser.
// ============================================================

// ------- SETTINGS YOU CAN CHANGE -------
const FUNDRAISING_URL =
  "https://www.peoplesfundraising.com/donation/in-it-for-the-long-run-";

// Count Strava activities from this date onwards (YYYY-MM-DD).
// Set this to your training start date.
const START_DATE = "2026-08-01";

// Which activity types count. Add "Walk" or "Ride" if wanted,
// e.g. ["Run", "Walk"]
const ACTIVITY_TYPES = ["Run"];
// ---------------------------------------

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "data.json");

function parseAmount(str) {
  return parseFloat(str.replace(/,/g, ""));
}

// ---- Part 1: scrape the fundraising page ----
async function getFundraising() {
  const res = await fetch(FUNDRAISING_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
      "Referer": "https://www.peoplesfundraising.com/",
    },
  });
  if (!res.ok) throw new Error(`Fundraising page returned ${res.status}`);
  const html = await res.text();

  const raisedMatch = html.match(
    /page-amount-and-supporters[\s\S]{0,800}?(?:&pound;|£)\s*([\d,]+(?:\.\d{1,2})?)/
  );
  if (!raisedMatch) {
    throw new Error(
      "Could not find the raised total on the page - the page layout may have changed."
    );
  }

  const supportersMatch = html.match(/raised by\s*<strong>\s*([\d,]+)/);
  const breakdownMatch = html.match(
    /(?:&pound;|£)\s*([\d,]+(?:\.\d{1,2})?)\s*donated plus\s*(?:&pound;|£)\s*([\d,]+(?:\.\d{1,2})?)\s*in GiftAid/i
  );

  return {
    totalRaised: parseAmount(raisedMatch[1]),
    donated: breakdownMatch ? parseAmount(breakdownMatch[1]) : null,
    giftAid: breakdownMatch ? parseAmount(breakdownMatch[2]) : null,
    supporters: supportersMatch ? parseInt(supportersMatch[1], 10) : null,
  };
}

// ---- Part 2: get individual runs from Strava ----
async function getStravaRuns() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.log("Strava secrets not set yet - skipping the runs update.");
    return null;
  }

  const tokenRes = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!tokenRes.ok) throw new Error(`Strava token request failed: ${tokenRes.status}`);
  const { access_token } = await tokenRes.json();

  const after = Math.floor(new Date(START_DATE + "T00:00:00Z").getTime() / 1000);
  let page = 1;
  const runs = [];

  while (true) {
    const actRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=200&page=${page}`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    if (!actRes.ok) throw new Error(`Strava activities request failed: ${actRes.status}`);
    const activities = await actRes.json();
    if (activities.length === 0) break;

    for (const a of activities) {
      if (ACTIVITY_TYPES.includes(a.type)) {
        runs.push({
          date: (a.start_date_local || a.start_date).slice(0, 10),
          distanceM: Math.round(a.distance),
          movingTimeS: a.moving_time,
        });
      }
    }
    page++;
  }

  // Oldest first - the same order the website expects
  runs.sort((a, b) => a.date.localeCompare(b.date));
  return runs;
}

// ---- Put it all together ----
async function main() {
  // Load the previous data so a partial failure never wipes good numbers
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    /* first run - no file yet */
  }

  const fundraising = await getFundraising();
  console.log(`Fundraising total: £${fundraising.totalRaised}`);

  let runs = null;
  try {
    runs = await getStravaRuns();
    if (runs) {
      const miles = runs.reduce((s, r) => s + r.distanceM, 0) / 1609.344;
      console.log(`Strava: ${runs.length} runs, ${miles.toFixed(1)} miles`);
    }
  } catch (err) {
    console.error(`Strava update failed (keeping previous runs): ${err.message}`);
  }

  const data = {
    lastUpdated: new Date().toISOString().slice(0, 10),
    raisedAmount: fundraising.totalRaised,
    fundraising,
    runs: runs ?? previous.runs ?? [],
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
  console.log(`Saved ${DATA_FILE}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
