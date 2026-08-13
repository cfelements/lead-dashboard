module.exports = async function handler(req, res) {
  const API_KEY = process.env.HUBSPOT_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_API_KEY nicht gesetzt.' });
  }

  const h = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

  try {
    // 1. Alle Deals laden (portalweit, nicht mehr auf einen Owner gefiltert)
    let allDeals = [];
    let after = undefined;
    do {
      const body = {
        filterGroups: [],
        properties: ['dealname', 'dealstage', 'createdate', 'closedate', 'hubspot_owner_id', 'hs_closed_lost_reason', 'closed_lost_reason'],
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
    const CHUNK = 100;

    // 2. Owner-Namen laden (aktive + archivierte, damit ehemalige Mitarbeiter lesbar bleiben)
    const ownerMap = {};
    try {
      for (const archived of [false, true]) {
        let oAfter = undefined;
        do {
          const url = `https://api.hubapi.com/crm/v3/owners?limit=100&archived=${archived}` + (oAfter ? `&after=${oAfter}` : '');
          const r = await fetch(url, { headers: h });
          if (!r.ok) break;
          const d = await r.json();
          (d.results || []).forEach(o => {
            const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim();
            ownerMap[String(o.id)] = {
              name: name || o.email || `Owner ${o.id}`,
              email: o.email || null,
              archived: !!archived,
            };
          });
          oAfter = d.paging?.next?.after;
        } while (oAfter);
      }
    } catch (e) {
      // Owner-Abruf fehlgeschlagen (fehlende Scope?) - Namen fallen auf IDs zurueck
    }

    // 3. Deal -> Notizen: pruefen ob Notizen vorhanden (v4)
    const hasNoteSet = new Set();
    try {
      for (let i = 0; i < dealIds.length; i += CHUNK) {
        const chunk = dealIds.slice(i, i + CHUNK);
        const r = await fetch('https://api.hubapi.com/crm/v4/associations/deals/notes/batch/read', {
          method: 'POST', headers: h,
          body: JSON.stringify({ inputs: chunk.map(id => ({ id })) })
        });
        if (!r.ok) continue;
        const d = await r.json();
        (d.results || []).forEach(item => {
          if (item.to && item.to.length > 0) hasNoteSet.add(String(item.from.id));
        });
      }
    } catch (e) {
      // Notizen-Abruf fehlgeschlagen - weiter ohne Notizen-Info
    }

    // 4. Deal -> Kontakt Associations (v4)
    const contactIdMap = {};
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

    // 5. Kontakte batch-lesen -> leadquelle
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

    // 6. Deals aufbereiten - Auswertung passiert im Frontend (wegen Mitarbeiter-Filter)
    const NO_OWNER = '__none__';
    const ownersSeen = {};
    const deals = allDeals.map(deal => {
      const p     = deal.properties ?? {};
      const cId   = contactIdMap[deal.id];
      const lq    = cId ? (leadquelleMap[cId] || 'Unbekannt') : 'Unbekannt';
      const oId   = p.hubspot_owner_id ? String(p.hubspot_owner_id) : NO_OWNER;
      const oName = oId === NO_OWNER
        ? 'Nicht zugewiesen'
        : (ownerMap[oId]?.name || `Owner ${oId}`);

      if (!ownersSeen[oId]) {
        ownersSeen[oId] = {
          id: oId,
          name: oName,
          email: ownerMap[oId]?.email || null,
          archived: ownerMap[oId]?.archived || false,
          count: 0,
        };
      }
      ownersSeen[oId].count++;

      return {
        name:       p.dealname || '\u2014',
        stage:      p.dealstage || 'unknown',
        leadquelle: lq,
        ownerId:    oId,
        ownerName:  oName,
        createdate: p.createdate || null,
        closedate:  p.closedate  || null,
        lostReason: p.hs_closed_lost_reason || p.closed_lost_reason || null,
        hasNote:    hasNoteSet.has(String(deal.id)),
      };
    });

    const owners = Object.values(ownersSeen).sort((a, b) => b.count - a.count);

    res.setHeader('Cache-Control', 's-maxage=60');
    res.json({ deals, owners, total: deals.length, ownerLookupOk: Object.keys(ownerMap).length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
