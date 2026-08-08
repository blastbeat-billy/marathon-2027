// ============================================================
// update-data.js
// Fetches the latest fundraising total from People's Fundraising
// and total miles from Strava, then saves both into data.json.
// Runs automatically via GitHub Actions (see .github/workflows/).
// ============================================================

// ------- SETTINGS YOU CAN CHANGE -------
const FUNDRAISING_URL =
  "https://www.peoplesfundraising.com/donation/in-it-for-the-long-run-";

// Count Strava activities from this date onwards (YYYY-MM-DD).
// Change this to the start date of your challenge.
const START_DATE = "2026-01-01";

// Which activity types count towards the miles total.
// Add "Walk" or "Ride" to the list if you want those included too,
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
    headers: { "User-Agent": "Mozilla/5.0 (fundraising totals updater)" },
  });
  if (!res.ok) throw new Error(`Fundraising page returned ${res.status}`);
  const html = await res.text();

  // The total sits inside the "page-amount-and-supporters" box,
  // e.g. <strong>&pound;137.50</strong> raised by <strong>1</strong> supporters
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

// ---- Part 2: get miles from Strava ----
async function getStravaMiles() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.log("Strava secrets not set yet - skipping the miles update.");
    return null;
  }

  // Swap our long-lived refresh token for a short-lived access token
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
  let totalMeters = 0;
  let activityCount = 0;

  // Fetch activities page by page (200 at a time) until there are no more
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
        totalMeters += a.distance;
        activityCount++;
      }
    }
    page++;
  }

  return {
    totalMiles: Math.round((totalMeters / 1609.344) * 10) / 10,
    activityCount,
    since: START_DATE,
  };
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

  let strava = null;
  try {
    strava = await getStravaMiles();
    if (strava) console.log(`Strava: ${strava.totalMiles} miles from ${strava.activityCount} activities`);
  } catch (err) {
    console.error(`Strava update failed (keeping previous miles): ${err.message}`);
  }

  const data = {
    fundraising,
    strava: strava ?? previous.strava ?? null,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
  console.log(`Saved ${DATA_FILE}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
