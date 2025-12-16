/** Simple, static MVP: ego-centric view with no backend.
 *  - Pan/zoom graph via Cytoscape
 *  - Click to open profile & interview
 *  - Double-click to re-center on that person
 *  - In-laws hidden unless you pivot (double-click spouse)
 *  - Data editable in data.json
 *  NOTE: Access code is client-side (MVP). For strong privacy we’ll upgrade later.
 */

const ACCESS_CODE = "MyFamilyPassword123"; // change to your family code

// UI elements
const gateEl = document.getElementById('gate');
const unlockBtn = document.getElementById('unlock');
const searchInput = document.getElementById('search');
const resetBtn = document.getElementById('reset');
const profileEl = document.getElementById('profile');

let DATA = null;          // loaded from data.json
let cy = null;            // cytoscape instance
let currentEgo = null;    // centered person id
let lastTap = { id: null, t: 0 };

// -------- Access gate --------
unlockBtn.addEventListener('click', () => {
  const input = document.getElementById('code').value.trim();
  if (input === ACCESS_CODE) {
    gateEl.style.display = 'none';
    init();
  } else {
    alert('Incorrect code.');
  }
});

// -------- Init: load data & draw first view --------
async function init() {
  try {
    const res = await fetch('data.json', { cache: 'no-store' });
    DATA = await res.json();
  } catch (e) {
    alert('Failed to load data.json. Make sure the file exists in the same folder.');
    console.error(e);
    return;
  }

  currentEgo = DATA.startEgoId;
  drawEgoView(currentEgo);

  // Search: jump to a person by name
  searchInput.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const match = DATA.people.find(p => p.name.toLowerCase().includes(q));
    if (match) {
      focusNode(match.id);
    }
  });

  // Reset view to starting ego
  resetBtn.addEventListener('click', () => {
    drawEgoView(DATA.startEgoId);
  });
}

// -------- Graph building logic (ego-centric rules) --------
function drawEgoView(egoId) {
  currentEgo = egoId;

  const { nodes, edges } = buildEgoGraph(egoId, {
    ancestorDepth: 3,
    descendantDepth: 2,
    includeCousins: true,
    showInLaws: false
  });

  // Create Cytoscape instance if not exists
  if (!cy) {
    cy = cytoscape({
      container: document.getElementById('cy'),
      elements: [
        ...nodes.map(n => ({ data: { id: n.id, label: n.label, sex: n.sex } })),
        ...edges.map(e => ({ data: { source: e.from, target: e.to, type: e.type } }))
      ],
      style: [
        {
          selector: 'node',
          style: {
            'label': 'data(label)',
            'text-valign': 'center',
            'text-halign': 'center',
            'background-color': ele => {
              const sex = ele.data('sex');
              if (sex === 'female') return '#f78da7';
              if (sex === 'male') return '#8ab4f8';
              return '#b0b0b0';
            },
            'shape': 'round-rectangle',
            'border-width': 1, 'border-color': '#333',
            'color': '#222', 'font-size': 12, 'padding': '8px',
            'width': 'label', 'height': 'label'
          }
        },
        {
          selector: 'edge',
          style: { 'line-color': '#999', 'width': 2, 'curve-style': 'bezier' }
        },
        {
          selector: 'edge[type = "PARENT_OF"]',
          style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': '#666' }
        },
        {
          selector: 'edge[type = "SPOUSE_OF"]',
          style: { 'width': 3, 'line-color': '#888' }
        }
      ],
      wheelSensitivity: 0.2 // nicer zoom
    });
  } else {
    cy.elements().remove();
    cy.add([
      ...nodes.map(n => ({ data: { id: n.id, label: n.label, sex: n.sex } })),
      ...edges.map(e => ({ data: { source: e.from, target: e.to, type: e.type } }))
    ]);
  }

  // Layout
  cy.layout({ name: 'fcose', animate: true, nodeRepulsion: 4500 }).run();

  // Interactions
  cy.off('tap'); // clear previous handlers
  cy.on('tap', 'node', (evt) => {
    const id = evt.target.id();
    openProfile(id);
    handleDoubleTap(id);
  });
}

// Helper: detect double tap within 300ms on same node
function handleDoubleTap(id) {
  const now = Date.now();
  if (lastTap.id === id && (now - lastTap.t) < 300) {
    // double tap → re-center
    drawEgoView(id);
  }
  lastTap = { id, t: now };
}

// Build ego view with rules
function buildEgoGraph(egoId, opts) {
  const peopleById = new Map(DATA.people.map(p => [p.id, p]));
  const rels = DATA.relationships;

  const include = new Set();
  const edges = [];

  const addNode = (id) => {
    if (!id || include.has(id) || !peopleById.has(id)) return;
    include.add(id);
  };

  const getParents = (id) => rels.filter(r => r.type === 'PARENT_OF' && r.to === id).map(r => r.from);
  const getChildren = (id) => rels.filter(r => r.type === 'PARENT_OF' && r.from === id).map(r => r.to);
  const getSpouses = (id) => {
    const s = rels.filter(r => r.type === 'SPOUSE_OF' && (r.from === id || r.to === id))
      .map(r => r.from === id ? r.to : r.from);
    return Array.from(new Set(s));
  };

  // Ego
  addNode(egoId);

  // Spouses (only connect to ego; do NOT expand their relatives)
  const spouses = getSpouses(egoId);
  spouses.forEach(s => { addNode(s); edges.push({ from: egoId, to: s, type: 'SPOUSE_OF' }); });

  // Children
  const children = getChildren(egoId);
  children.forEach(c => { addNode(c); edges.push({ from: egoId, to: c, type: 'PARENT_OF' }); });

  // Parents
  const parents = getParents(egoId);
  parents.forEach(p => { addNode(p); edges.push({ from: p, to: egoId, type: 'PARENT_OF' }); });

  // Siblings (other children of ego's parents)
  const siblingIds = new Set();
  parents.forEach(p => {
    getChildren(p).forEach(ch => {
      if (ch !== egoId) {
        siblingIds.add(ch);
        addNode(ch);
        edges.push({ from: p, to: ch, type: 'PARENT_OF' });
      }
    });
  });

  // Ancestors up to depth N (only from ego, not spouses)
  function addAncestors(id, depth) {
    if (depth <= 0) return;
    const ps = getParents(id);
    ps.forEach(p => {
      addNode(p);
      edges.push({ from: p, to: id, type: 'PARENT_OF' });
      addAncestors(p, depth - 1);
    });
  }
  addAncestors(egoId, opts.ancestorDepth);

  // Descendants up to depth M (only from ego)
  function addDescendants(id, depth) {
    if (depth <= 0) return;
    const cs = getChildren(id);
    cs.forEach(c => {
      addNode(c);
      edges.push({ from: id, to: c, type: 'PARENT_OF' });
      addDescendants(c, depth - 1);
    });
  }
  addDescendants(egoId, opts.descendantDepth);

  // Cousins (siblings' children)
  if (opts.includeCousins) {
    siblingIds.forEach(sib => {
      getChildren(sib).forEach(cu => {
        addNode(cu);
        edges.push({ from: sib, to: cu, type: 'PARENT_OF' });
      });
    });
  }

  // Compose nodes list
  const nodes = Array.from(include).map(id => {
    const p = peopleById.get(id);
    return { id, label: p.name, sex: p.sex || 'unknown' };
  });

  // Only keep edges between included nodes
  const filteredEdges = edges.filter(e => include.has(e.from) && include.has(e.to));

  return { nodes, edges: filteredEdges };
}

// -------- Profile panel with interview embed --------
function openProfile(personId) {
  const p = DATA.people.find(x => x.id === personId);
  if (!p) return;
  const videoHtml = renderVideo(p.video);
  profileEl.innerHTML = `
    <h2>${escapeHtml(p.name)}</h2>
    <div class="grid">
      <div><strong>Sex:</strong> ${escapeHtml(p.sex || 'unknown')}</div>
    </div>
    ${videoHtml ? `<div class="video">${videoHtml}</div>` : `<p>No interview available yet.</p>`}
    <p style="margin-top:8px;"><em>Double‑click this person on the graph to re‑center around them.</em></p>
  `;
}

// Render video: supports YouTube/Vimeo embeds or direct MP4
function renderVideo(url) {
  if (!url) return '';
  const u = String(url).trim();

  // YouTube
  if (u.includes('youtube.com') || u.includes('youtu.be')) {
    const idMatch =
      u.match(/v=([^&]+)/) ||
      u.match(/youtu\.be\/([^?]+)/);
    const vid = idMatch ? idMatch[1] : null;
    if (!vid) return '';
    return `<div class="embed">https://www.youtube.com/embed/${vid}</iframe></div>`;
  }

  // Vimeo (password can be set in Vimeo; iframe respects it)
  if (u.includes('vimeo.com')) {
    const idMatch = u.match(/vimeo\.com\/(\d+)/);
    const vid = idMatch ? idMatch[1] : null;
    if (!vid) return '';
    return `<div class="embed">https://player.vimeo.com/video/${vid}</iframe></div>`;
  }

  // Direct MP4
  if (u.endsWith('.mp4')) {
    return `<video controls width="100%">${escapeHtml(u)}Your browser does not support the video tag.</video>`;
  }

  // Fallback: link
  return `<p>${escapeHtml(u)}Open interview</a></p>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// Focus/zoom to a node by id
function focusNode(id) {
  if (!cy) return;
  const node = cy.$(`node[id = "${CSS.escape(id)}"]`);
  if (node && node.length) {
    cy.fit(node, 50);
    node.animate({ style: { 'border-color': '#ff9800', 'border-width': 3 } }, { duration: 300 });
    setTimeout(() => node.animate({ style: { 'border-color': '#333', 'border-width': 1 } }, { duration: 300 }), 800);
  }