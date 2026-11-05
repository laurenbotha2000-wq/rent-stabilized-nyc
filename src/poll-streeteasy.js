import { StreetEasyClient, Areas, Amenities } from 'streeteasy-api';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const client = new StreetEasyClient();

async function pollAndSaveListings() {
  try {
    console.log('Fetching listings from StreetEasy...');

    const response = await client.searchRentals({
      filters: {
        areas: [Areas.MANHATTAN, Areas.BROOKLYN],
        amenities: [Amenities.LAUNDRY_IN_BUILDING],
      },
      perPage: 50,
      page: 1,
    });

    const listings = response.searchRentals.edges.map(edge => edge.node);
    console.log(`Fetched ${listings.length} listings. Syncing to DB...`);

    for (const listing of listings) {
      const query = `
        INSERT INTO listings (
          streeteasy_id, 
          address, 
          unit, 
          price, 
          bedroom_count, 
          bathroom_count, 
          area_name, 
          raw_data, 
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (streeteasy_id) 
        DO UPDATE SET
          price = EXCLUDED.price,
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
        JSON.stringify(listing),
      ];

      const res = await pool.query(query, values);
      console.log(`Saved listing: ${res.rows[0].streeteasy_id} - ${res.rows[0].address}`);
    }
  } catch (err) {
    console.error('Scraper error:', err);
  } finally {
    await pool.end();
  }
}

pollAndSaveListings();
