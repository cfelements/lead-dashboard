module.exports = async function handler(req, res) {
  const API_KEY = process.env.HUBSPOT_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'HUBSPOT_API_KEY nicht gesetzt.' });
  }

  const h = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

  /* Notizen werden erst beim Klick geladen, nicht beim Seitenaufbau */
  const dealId = req.query?.dealId;
  if (dealId) {
    try {
      if (!/^\d+$/.test(String(dealId))) throw new Error('Ung\u00fcltige Deal-ID');

      const aRes = await fetch(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/notes?limit=100`, { headers: h });
      if (!aRes.ok) throw new Error(`Associations API: ${aRes.status}`);
      const aData = await aRes.json();
      const noteIds = [...new Set((aData.results || []).map(r => String(r.toObjectId)))];
      if (!noteIds.length) return res.json({ notes: [] });

      const notes = [];
      for (let i = 0; i < noteIds.length; i += 100) {
        const r = await fetch('https://api.hubapi.com/crm/v3/objects/notes/batch/read', {
          method: 'POST', headers: h,
          body: JSON.stringify({
            inputs: noteIds.slice(i, i + 100).map(id => ({ id })),
            properties: ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id'],
          })
        });
        if (!r.ok) continue;
        const d = await r.json();
        (d.results || []).forEach(n => notes.push({
          id: n.id,
          body: (n.properties?.hs_note_body || '').slice(0, 60000),
          ts: n.properties?.hs_timestamp || n.createdAt || null,
          ownerId: n.properties?.hubspot_owner_id ? String(n.properties.hubspot_owner_id) : null,
        }));
      }

      notes.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
      res.setHeader('Cache-Control', 's-maxage=30');
      return res.json({ notes });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

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

    // 3. Deal -> Notizen: Anzahl ermitteln (Texte werden erst bei Bedarf geladen)
    const noteCountMap = {};
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
          const n = item.to ? item.to.length : 0;
          if (n > 0) noteCountMap[String(item.from.id)] = n;
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

      const nCount = noteCountMap[String(deal.id)] || 0;

      return {
        id:         String(deal.id),
        name:       p.dealname || '\u2014',
        stage:      p.dealstage || 'unknown',
        leadquelle: lq,
        ownerId:    oId,
        ownerName:  oName,
        createdate: p.createdate || null,
        closedate:  p.closedate  || null,
        lostReason: p.hs_closed_lost_reason || p.closed_lost_reason || null,
        noteCount:  nCount,
        hasNote:    nCount > 0,
      };
    });

    const owners = Object.values(ownersSeen).sort((a, b) => b.count - a.count);

    res.setHeader('Cache-Control', 's-maxage=60');
    res.json({ deals, owners, total: deals.length, ownerLookupOk: Object.keys(ownerMap).length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
