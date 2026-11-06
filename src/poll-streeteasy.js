import { StreetEasyClient, Areas } from 'streeteasy-api';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const client = new StreetEasyClient();

// Interval between full cycle polls (30 minutes)
const POLL_INTERVAL_MS = 30 * 60 * 1000;

// All major NYC areas to avoid hitting single-search pagination caps
const ALL_AREAS = [
  Areas.MANHATTAN,
  Areas.BROOKLYN,
  Areas.QUEENS,
  Areas.BRONX,
  Areas.STATEN_ISLAND,
];

async function pollAreaListings(area) {
  let page = 1;
  let hasMore = true;
  let areaNewListings = 0;

  console.log(`[${new Date().toISOString()}] Syncing listings for area: ${area}...`);

  while (hasMore) {
    try {
      const response = await client.searchRentals({
        filters: { areas: [area] },
        perPage: 50,
        page: page,
      });

      const listings = response.searchRentals?.edges?.map(edge => edge.node) || [];

      if (listings.length === 0) {
        hasMore = false;
        break;
      }

      for (const listing of listings) {
        // Extract array of photo URLs if present on the node payload
        const photoUrls = 
          listing.photos?.map(p => typeof p === 'string' ? p : p.url) || 
          listing.images?.map(img => typeof img === 'string' ? img : img.url) || 
          (listing.primaryImage ? [listing.primaryImage.url || listing.primaryImage] : []);

        const query = `
          INSERT INTO listings (
            streeteasy_id, 
            address, 
            unit, 
            price, 
            bedroom_count, 
            bathroom_count, 
            area_name, 
            photos,
            raw_data, 
            created_at, 
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
          ON CONFLICT (streeteasy_id) 
          DO UPDATE SET
            price = EXCLUDED.price,
            photos = EXCLUDED.photos,
            raw_data = EXCLUDED.raw_data,
            updated_at = NOW()
          RETURNING streeteasy_id, address;
        `;

        const values = [
          listing.id,
          listing.street,
          listing.unit || null,
          listing.price,
          listing.bedroomCount,
          listing.fullBathroomCount,
          listing.areaName,
          photoUrls, // Saved directly as PostgreSQL TEXT[] array
          JSON.stringify(listing),
        ];

        const res = await pool.query(query, values);
        if (res.rowCount > 0) {
          areaNewListings++;
          console.log(`NEW LISTING: ${res.rows[0].streeteasy_id} - ${res.rows[0].address}`);
        }
      }

      if (listings.length < 50) {
        hasMore = false;
      } else {
        page++;
        // 1.5 second rate-limiting buffer between pages
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    } catch (err) {
      console.error(`Error fetching page ${page} for area ${area}:`, err);
      hasMore = false;
    }
  }

  console.log(`Finished ${area}. Added ${areaNewListings} new listings.`);
}

async function fetchAllUnseenListings() {
  console.log(`=== Starting Full StreetEasy Poll Cycle ===`);
  for (const area of ALL_AREAS) {
    await pollAreaListings(area);
  }
  console.log(`=== Full Poll Cycle Complete ===`);
}

async function startPoller() {
  await fetchAllUnseenListings();
  setInterval(async () => {
    await fetchAllUnseenListings();
  }, POLL_INTERVAL_MS);
}

startPoller();
