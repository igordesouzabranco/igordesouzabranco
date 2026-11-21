// Gera assets/github-stats-terminal.svg com dados reais da API do GitHub.
// Uso: GITHUB_TOKEN=... GH_USER=igordesouzabranco node scripts/generate-stats.mjs
// Sem dependências: precisa só do Node 18+ (fetch nativo).

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const USER = process.env.GH_USER || process.env.GITHUB_REPOSITORY_OWNER || 'igordesouzabranco';
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = process.env.OUT || 'assets/github-stats-terminal.svg';
// Ex.: EXCLUDE_LANGS="HTML,CSS" para esconder linguagens do gráfico
const EXCLUDE_LANGS = (process.env.EXCLUDE_LANGS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const TOP_LANGS = 6;

/* ---------- API ---------- */

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'github-stats-terminal',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

export async function fetchStats(login) {
  // 1) números gerais
  const base = (
    await gql(
      `query($login:String!) {
        user(login:$login) {
          createdAt
          followers { totalCount }
          pullRequests { totalCount }
          issues { totalCount }
          repositoriesContributedTo(first:1, includeUserRepositories:false,
            contributionTypes:[COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount }
          contributionsCollection { totalPullRequestReviewContributions }
        }
      }`,
      { login },
    )
  ).user;

  // 2) estrelas e linguagens dos repositórios próprios (sem forks)
  let stars = 0;
  const langs = new Map();
  let cursor = null;
  do {
    const d = await gql(
      `query($login:String!, $cursor:String) {
        user(login:$login) {
          repositories(first:100, after:$cursor, ownerAffiliations:OWNER, isFork:false) {
            pageInfo { hasNextPage endCursor }
            nodes {
              stargazerCount
              languages(first:10, orderBy:{field:SIZE, direction:DESC}) {
                edges { size node { name } }
              }
            }
          }
        }
      }`,
      { login, cursor },
    );
    const r = d.user.repositories;
    for (const n of r.nodes) {
      stars += n.stargazerCount;
      for (const e of n.languages.edges) {
        langs.set(e.node.name, (langs.get(e.node.name) || 0) + e.size);
      }
    }
    cursor = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (cursor);

  // 3) commits de todos os anos (a API limita cada consulta a 1 ano)
  const startYear = new Date(base.createdAt).getUTCFullYear();
  const thisYear = new Date().getUTCFullYear();
  const parts = [];
  for (let y = startYear; y <= thisYear; y++) {
    parts.push(
      `y${y}: contributionsCollection(from:"${y}-01-01T00:00:00Z", to:"${y}-12-31T23:59:59Z") { totalCommitContributions }`,
    );
  }
  const c = (await gql(`query($login:String!){ user(login:$login){ ${parts.join('\n')} } }`, { login })).user;
  const commits = Object.values(c).reduce((sum, v) => sum + v.totalCommitContributions, 0);

  return {
    stars,
    commits,
    prs: base.pullRequests.totalCount,
    issues: base.issues.totalCount,
    contributed: base.repositoriesContributedTo.totalCount,
    reviews: base.contributionsCollection.totalPullRequestReviewContributions,
    followers: base.followers.totalCount,
    langs: [...langs.entries()].map(([name, size]) => ({ name, size })),
  };
}

/* ---------- rank (mesma fórmula do github-readme-stats) ---------- */

const LEVELS = ['S', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C'];
const THRESHOLDS = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
const expCdf = (x) => 1 - 2 ** -x;
const logCdf = (x) => x / (1 + x);

export function calcRank({ commits, prs, issues, reviews, stars, followers }) {
  const W = { commits: 2, prs: 3, issues: 1, reviews: 1, stars: 4, followers: 1 };
  const total = Object.values(W).reduce((a, b) => a + b, 0);
  const score =
    (W.commits * expCdf(commits / 250) +
      W.prs * expCdf(prs / 50) +
      W.issues * expCdf(issues / 25) +
      W.reviews * expCdf(reviews / 2) +
      W.stars * logCdf(stars / 50) +
      W.followers * logCdf(followers / 10)) /
    total;
  const pct = (1 - score) * 100;
  const idx = THRESHOLDS.findIndex((t) => pct <= t);
  return { level: LEVELS[idx], next: idx > 0 ? LEVELS[idx - 1] : null };
}

/* ---------- SVG ---------- */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => Number(n).toLocaleString('pt-BR');
const PALETTE = ['#2bff2b', '#1fe0a0', '#00d9ff', '#3aa0ff', '#7a7cff', '#b36bff'];

export function renderSvg(stats, { login = USER, date = new Date() } = {}) {
  const rank = calcRank(stats);
  const updated = date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const included = stats.langs.filter((l) => !EXCLUDE_LANGS.includes(l.name.toLowerCase()));
  const totalSize = included.reduce((s, l) => s + l.size, 0) || 1;
  const top = included
    .sort((a, b) => b.size - a.size)
    .slice(0, TOP_LANGS)
    .map((l) => ({ name: l.name, pct: (l.size / totalSize) * 100 }));

  const rows = [
    ['stars_earned', stats.stars],
    ['total_commits', stats.commits],
    ['pull_requests', stats.prs],
    ['issues', stats.issues],
    ['contributed_to', stats.contributed],
  ];

  const statRows = rows
    .map(([label, value], i) => {
      const y = 116 + i * 26;
      return `    <g class="a" style="animation-delay:${(1.9 + i * 0.15).toFixed(2)}s">
      <text x="54" y="${y}" class="w">${label}</text>
      <line x1="200" y1="${y - 4}" x2="320" y2="${y - 4}" stroke="#2bff2b" stroke-opacity="0.35" stroke-dasharray="1 5" stroke-linecap="round"/>
      <text x="345" y="${y}" text-anchor="end" class="g">${fmt(value)}</text>
    </g>`;
    })
    .join('\n');

  const langRows = top
    .map((l, i) => {
      const y = 304 + i * 26;
      const w = Math.max((500 * l.pct) / 100, 6).toFixed(2);
      const delay = (4.3 + i * 0.2).toFixed(1);
      return `  <g class="a" style="animation-delay:${delay}s">
    <text x="54" y="${y}" class="w s">${esc(l.name)}</text>
    <rect x="170" y="${y - 11}" width="500" height="12" rx="2" fill="#0f2a0f"/>
    <rect x="170" y="${y - 11}" width="${w}" height="12" rx="2" fill="${PALETTE[i]}" filter="url(#glow)"><animate attributeName="width" from="0" to="${w}" dur="1s" begin="${delay}s" fill="freeze"/></rect>
    <text x="690" y="${y}" class="g s">${l.pct.toFixed(2)}%</text>
  </g>`;
    })
    .join('\n');

  const nextLabel = rank.next ? `// next: ${rank.next}` : '// nível máximo';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="860" height="500" viewBox="0 0 860 500" role="img" aria-label="GitHub stats de ${esc(login)} em formato de terminal">
  <title>GitHub stats - ${esc(login)}</title>
  <defs>
    <filter id="glow" x="-5%" y="-30%" width="110%" height="160%">
      <feGaussianBlur stdDeviation="1.6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="1" fill="#2bff2b" opacity="0.05"/>
    </pattern>
    <clipPath id="type1"><rect x="34" y="62" width="520" height="26">
      <animate attributeName="width" from="0" to="520" dur="1.5s" begin="0s" fill="freeze"/>
    </rect></clipPath>
    <clipPath id="type2"><rect x="34" y="250" width="520" height="26">
      <animate attributeName="width" from="0" to="520" dur="1.1s" begin="3.2s" fill="freeze"/>
    </rect></clipPath>
  </defs>

  <style>
    text { font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Courier New', monospace; font-size: 15px; }
    .g  { fill: #2bff2b; }
    .w  { fill: #d6ffd6; }
    .c  { fill: #00d9ff; }
    .d  { fill: #5f8f5f; }
    .s  { font-size: 14px; }
    @keyframes fi { from { opacity: 0; } to { opacity: 1; } }
    .a { animation: fi .4s ease-out both; }
  </style>

  <rect x="10" y="10" width="840" height="480" rx="10" fill="#050805" stroke="#2bff2b" stroke-opacity="0.55"/>
  <path d="M10 20a10 10 0 0 1 10-10h820a10 10 0 0 1 10 10v24H10z" fill="#0d160d"/>
  <circle cx="32" cy="27" r="6" fill="#ff5f56"/>
  <circle cx="54" cy="27" r="6" fill="#ffbd2e"/>
  <circle cx="76" cy="27" r="6" fill="#27c93f"/>
  <text x="430" y="32" text-anchor="middle" class="d s">igor@dev: ~/github-stats</text>
  <rect x="10" y="44" width="840" height="446" fill="url(#scan)"/>

  <g clip-path="url(#type1)" filter="url(#glow)">
    <text x="34" y="80"><tspan class="g">igor@dev</tspan><tspan class="c">:~$</tspan><tspan class="w"> gh stats --user ${esc(login)}</tspan></text>
  </g>

  <g filter="url(#glow)">
${statRows}
  </g>

  <g class="a" style="animation-delay:2.6s">
    <rect x="560" y="98" width="270" height="134" rx="6" fill="none" stroke="#2bff2b" stroke-opacity="0.6" stroke-dasharray="5 4"/>
    <text x="580" y="122" class="d s"># rank</text>
    <text x="695" y="188" text-anchor="middle" class="g" filter="url(#glow)" style="font-size:58px;font-weight:700">${esc(rank.level)}</text>
    <text x="695" y="216" text-anchor="middle" class="c s">${nextLabel}</text>
  </g>

  <g class="a" style="animation-delay:3.2s">
    <g clip-path="url(#type2)" filter="url(#glow)">
      <text x="34" y="268"><tspan class="g">igor@dev</tspan><tspan class="c">:~$</tspan><tspan class="w"> gh langs --top ${top.length}</tspan></text>
    </g>
  </g>

${langRows}

  <g class="a" style="animation-delay:5.8s" filter="url(#glow)">
    <text x="34" y="466"><tspan class="g">igor@dev</tspan><tspan class="c">:~$</tspan></text>
    <rect x="142" y="452" width="9" height="16" fill="#2bff2b">
      <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>
    </rect>
    <text x="170" y="466" class="d s"># atualizado em ${updated}</text>
  </g>
</svg>
`;
}

/* ---------- main ---------- */

async function main() {
  if (!TOKEN) throw new Error('Defina GITHUB_TOKEN (no Actions já vem pronto).');
  const stats = await fetchStats(USER);
  const svg = renderSvg(stats, { login: USER });
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, svg);
  console.log(`ok: ${OUT}`, { ...stats, langs: stats.langs.length });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
