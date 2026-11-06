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

/**
 * Safely extracts photo URL strings from StreetEasy GraphQL listing responses.
 * StreetEasy returns photo objects with S3 keys like `{ key: "..." }`.
 */
function extractPhotoUrls(listing) {
  // Grab photo candidates (photos array, images array, or primaryImage fallback)
  const rawPhotos = 
    listing.photos || 
    listing.images || 
    (listing.primaryImage ? [listing.primaryImage] : []);

  if (!Array.isArray(rawPhotos)) return [];

  return rawPhotos
    .map(p => {
      if (!p) return null;
      if (typeof p === 'string') return p;
      // Convert StreetEasy photo key objects { key: "123456" } into CDN image URLs
      if (p.key) return `https://images.streeteasy.com/photos/${p.key}`;
      // Fallback for standard URL object properties
      return p.url || p.fullUrl || p.src || p.largeUrl || p.mediumUrl || null;
    })
    .filter(url => typeof url === 'string' && url.trim().length > 0);
}

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

        const photoUrls = extractPhotoUrls(listing);

        const docSnapshot = await docRef.get();

        const listingData = {
          streeteasy_id: docId,
          address: listing.street || listing.address || '',
          unit: listing.unit || null,
          price: listing.price || 0,
          bedroom_count: listing.bedroomCount || listing.bedrooms || 0,
          bathroom_count: listing.fullBathroomCount || listing.bathrooms || 0,
          area_name: listing.areaName || listing.area || '',
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
