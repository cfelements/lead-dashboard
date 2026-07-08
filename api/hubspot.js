const OWNER_ID = '90396933';

module.exports = async function handler(req, res) {
  const API_KEY = process.env.HUBSPOT_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_API_KEY nicht gesetzt.' });
  }

  const h = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

  try {
    // 1. Alle Deals laden
    let allDeals = [];
    let after = undefined;
    do {
      const body = {
        filterGroups: [{ filters: [{ propertyName: 'hubspot_owner_id', operator: 'EQ', value: OWNER_ID }] }],
        properties: ['dealname', 'dealstage', 'createdate', 'closedate'],
        limit: 100,
        ...(after ? { after } : {})
      };
      const r = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
        method: 'POST', headers: h, body: JSON.stringify(body)
      });
      if (!r.ok) throw new Error(`Deals API: ${r.status}`);
      const d = await r.json();
      allDeals = allDeals.concat(d.results || []);
      after = d.paging?.next?.after;
    } while (after);

    const dealIds = allDeals.map(d => d.id);

    // 2. Deal → Kontakt Associations (v4)
    const contactIdMap = {};
    const CHUNK = 100;
    for (let i = 0; i < dealIds.length; i += CHUNK) {
      const chunk = dealIds.slice(i, i + CHUNK);
      const r = await fetch('https://api.hubapi.com/crm/v4/associations/deals/contacts/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({ inputs: chunk.map(id => ({ id })) })
      });
      if (!r.ok) continue;
      const d = await r.json();
      (d.results || []).forEach(item => {
        const cId = item.to?.[0]?.toObjectId;
        if (cId) contactIdMap[item.from.id] = String(cId);
      });
    }

    // 3. Kontakte batch-lesen → leadquelle
    const contactIds = [...new Set(Object.values(contactIdMap))];
    const leadquelleMap = {};
    for (let i = 0; i < contactIds.length; i += CHUNK) {
      const chunk = contactIds.slice(i, i + CHUNK);
      const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/read', {
        method: 'POST', headers: h,
        body: JSON.stringify({ inputs: chunk.map(id => ({ id })), properties: ['leadquelle'] })
      });
      if (!r.ok) continue;
      const d = await r.json();
      (d.results || []).forEach(c => {
        const lq = c.properties?.leadquelle;
        leadquelleMap[c.id] = (lq && lq !== 'Unassigned') ? lq : 'Unbekannt';
      });
    }

    // 4. Auswerten
    const byStage = {}, byMonth = {}, byLeadquelle = {}, deals = [];
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth()-1, 1);
    const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth()+1).padStart(2,'0')}`;

    // Für Ø Abschlussdauer
    const daysToClose = [];          // alle
    const daysToCloseThisMonth = []; // nur Abschlüsse diesen Monat
    const daysToCloseLastMonth = []; // nur Abschlüsse letzten Monat

    allDeals.forEach(deal => {
      const p     = deal.properties ?? {};
      const stage = p.dealstage || 'unknown';
      const cId   = contactIdMap[deal.id];
      const lq    = cId ? (leadquelleMap[cId] || 'Unbekannt') : 'Unbekannt';

      byStage[stage]   = (byStage[stage]   || 0) + 1;
      byLeadquelle[lq] = (byLeadquelle[lq] || 0) + 1;
      if (p.createdate) {
        const m = p.createdate.substring(0, 7);
        byMonth[m] = (byMonth[m] || 0) + 1;
      }

      // Abschlussdauer für Closed Won
      if (stage === 'closedwon' && p.createdate && p.closedate) {
        const days = Math.round((new Date(p.closedate) - new Date(p.createdate)) / 86400000);
        if (days >= 0) {
          daysToClose.push(days);
          const closeMonth = p.closedate.substring(0, 7);
          if (closeMonth === thisMonth) daysToCloseThisMonth.push(days);
          if (closeMonth === lastMonth) daysToCloseLastMonth.push(days);
        }
      }

      deals.push({ name: p.dealname || '—', stage, leadquelle: lq, createdate: p.createdate || null });
    });

    const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    const avgDays = {
      all:       avg(daysToClose),
      thisMonth: avg(daysToCloseThisMonth),
      lastMonth: avg(daysToCloseLastMonth),
    };

    res.setHeader('Cache-Control', 's-maxage=60');
    res.json({ byStage, byMonth, byLeadquelle, deals, total: allDeals.length, avgDays });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
