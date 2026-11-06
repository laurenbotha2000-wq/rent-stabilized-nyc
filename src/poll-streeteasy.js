import { StreetEasyClient, Areas } from 'streeteasy-api';
import { Firestore } from '@google-cloud/firestore';

// Initialize Firestore client
const db = new Firestore();
const listingsCollection = db.collection('listings');

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
        const docId = String(listing.id || listing.streeteasyId);
        const docRef = listingsCollection.doc(docId);

        // Extract photo URLs array if present
        const photoUrls = 
          listing.photos?.map(p => typeof p === 'string' ? p : p.url) || 
          listing.images?.map(img => typeof img === 'string' ? img : img.url) || 
          (listing.primaryImage ? [listing.primaryImage.url || listing.primaryImage] : []);

        const docSnapshot = await docRef.get();

        const listingData = {
          streeteasy_id: docId,
          address: listing.street || '',
          unit: listing.unit || null,
          price: listing.price || 0,
          bedroom_count: listing.bedroomCount || 0,
          bathroom_count: listing.fullBathroomCount || 0,
          area_name: listing.areaName || '',
          photos: photoUrls,
          raw_data: listing,
          updated_at: new Date().toISOString(),
        };

        if (!docSnapshot.exists) {
          // Document is unseen: insert new Firestore record
          listingData.created_at = new Date().toISOString();
          await docRef.set(listingData);
          areaNewListings++;
          console.log(`NEW UNSEEN LISTING ADDED TO FIRESTORE: ${docId} - ${listingData.address}`);
        } else {
          // Document exists: update existing fields
          await docRef.update({
            price: listingData.price,
            photos: listingData.photos,
            raw_data: listingData.raw_data,
            updated_at: listingData.updated_at,
          });
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
