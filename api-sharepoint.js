/**
 * SharePoint Data Fetcher API
 * Deploy on Vercel: https://vercel.com
 * 
 * Setup:
 * 1. Create a new Vercel project from GitHub
 * 2. Create folder: api/sharepoint.js (this file)
 * 3. Set environment variables in Vercel dashboard:
 *    - AZURE_CLIENT_ID
 *    - AZURE_CLIENT_SECRET
 *    - AZURE_TENANT_ID
 * 4. Vercel auto-deploys - get your URL from dashboard
 * 
 * API Usage:
 * POST https://your-project.vercel.app/api/sharepoint
 * Body: { "siteUrl": "...", "listName": "..." }
 * Returns: { "success": true, "data": [...], "rowCount": N }
 */

export default async function handler(req, res) {
  // Enable CORS for dashboard
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { siteUrl, listName } = req.body;

  // Validate input
  if (!siteUrl || !listName) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['siteUrl', 'listName']
    });
  }

  // Check environment variables
  if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_CLIENT_SECRET || !process.env.AZURE_TENANT_ID) {
    console.error('Missing Azure environment variables');
    return res.status(500).json({ 
      error: 'Server configuration error',
      details: 'Azure credentials not configured'
    });
  }

  try {
    console.log(`[${new Date().toISOString()}] Fetching data from SharePoint`);
    console.log(`Site: ${siteUrl}, List: ${listName}`);

    // STEP 1: Get OAuth Token from Azure AD
    const accessToken = await getAccessToken();
    if (!accessToken) {
      throw new Error('Failed to obtain access token');
    }

    // STEP 2: Get SharePoint Site ID
    const siteId = await getSiteId(siteUrl, accessToken);
    if (!siteId) {
      throw new Error(`SharePoint site not found: ${siteUrl}`);
    }
    console.log(`Site ID: ${siteId}`);

    // STEP 3: Get List ID
    const listId = await getListId(siteId, listName, accessToken);
    if (!listId) {
      throw new Error(`List "${listName}" not found in site`);
    }
    console.log(`List ID: ${listId}`);

    // STEP 4: Fetch all items from list
    const items = await getListItems(siteId, listId, accessToken);
    console.log(`Retrieved ${items.length} items`);

    // STEP 5: Transform to Excel-like format
    const rows = transformItems(items);

    return res.status(200).json({
      success: true,
      rowCount: rows.length,
      lastSync: new Date().toISOString(),
      data: rows
    });

  } catch (error) {
    console.error('API Error:', error.message);
    return res.status(500).json({ 
      success: false,
      error: error.message,
      hint: 'Check SharePoint URL, List name, and Azure permissions'
    });
  }
}

/**
 * Get OAuth access token from Azure AD
 */
async function getAccessToken() {
  try {
    const tokenUrl = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`;
    
    const body = new URLSearchParams({
      client_id: process.env.AZURE_CLIENT_ID,
      client_secret: process.env.AZURE_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
    });

    const data = await response.json();
    
    if (!data.access_token) {
      console.error('Token response:', data);
      throw new Error('Failed to get access token');
    }

    return data.access_token;
  } catch (error) {
    console.error('getAccessToken error:', error);
    throw error;
  }
}

/**
 * Get SharePoint Site ID using Microsoft Graph API
 */
async function getSiteId(siteUrl, accessToken) {
  try {
    // Extract hostname and path from URL
    // e.g., https://company.sharepoint.com/sites/MySite
    const url = new URL(siteUrl);
    const hostname = url.hostname;
    const path = url.pathname.split('/').filter(p => p).join('/');
    
    // Microsoft Graph format: hostname:/sites/sitename
    const graphUrl = `https://graph.microsoft.com/v1.0/sites/${hostname}:/${path}`;
    
    const response = await fetch(graphUrl, {
      method: 'GET',
      headers: { 
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`SharePoint site not found (${response.status})`);
    }

    const data = await response.json();
    return data.id;
  } catch (error) {
    console.error('getSiteId error:', error);
    throw error;
  }
}

/**
 * Get List ID by name
 */
async function getListId(siteId, listName, accessToken) {
  try {
    const graphUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists?$filter=displayName eq '${listName}'`;
    
    const response = await fetch(graphUrl, {
      method: 'GET',
      headers: { 
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    
    if (!data.value || data.value.length === 0) {
      throw new Error(`List "${listName}" not found`);
    }

    return data.value[0].id;
  } catch (error) {
    console.error('getListId error:', error);
    throw error;
  }
}

/**
 * Get all items from a list (with pagination)
 */
async function getListItems(siteId, listId, accessToken) {
  try {
    const items = [];
    let url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=100`;
    
    while (url) {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      
      if (data.value) {
        items.push(...data.value);
      }

      // Pagination: get next page if available
      url = data['@odata.nextLink'];
    }

    return items;
  } catch (error) {
    console.error('getListItems error:', error);
    throw error;
  }
}

/**
 * Transform SharePoint items to Excel-like row format
 */
function transformItems(items) {
  return items.map(item => {
    const fields = item.fields || {};
    
    // Map SharePoint fields to your Excel column names
    // Adjust field names to match your SharePoint list
    return {
      // Basic fields
      'Order Number': fields.OrderNumber || fields.Title || '—',
      'User Name': fields.UserName || fields.Customer || '—',
      
      // Financial fields
      'Total Cost': parseFloat(fields.TotalCost) || 0,
      'Total Price with out GST': parseFloat(fields.TotalPrice) || 0,
      
      // Logistics fields
      'LM': fields.LM || fields.LastMile || '—',
      'Mid Mile ': fields.MidMile || '—',
      'Provider': fields.Provider || '—',
      'Zone': fields.Zone || '—',
      
      // Weight fields
      'Actual Weight': parseFloat(fields.ActualWeight) || 0,
      'Package Round weight': parseFloat(fields.PackageRoundWeight) || 0,
      
      // Date fields
      'Handover Date': fields.HandoverDate || '—',
      'Manifested Date': fields.ManifestDate || '—',
      'Pickup Date': fields.PickupDate || '—',
      
      // Spread remaining fields (for any extra columns)
      ...fields
    };
  });
}

/**
 * CUSTOMIZATION GUIDE:
 * 
 * If your SharePoint list has different column names:
 * 
 * 1. Open SharePoint list
 * 2. Click on column header → "Column settings"
 * 3. Check the "Internal Name" (e.g., "Order_x0020_Number")
 * 4. Update the mapping above:
 *    'Order Number': fields.Order_x0020_Number || fields.Title,
 * 
 * Common SharePoint field types:
 * - Single line text: String
 * - Number: parseFloat(fields.ColumnName)
 * - Date: fields.ColumnName (ISO format)
 * - Person/Group: fields.ColumnName?.displayName
 * - Lookup: fields.ColumnName[0]?.displayName
 */
