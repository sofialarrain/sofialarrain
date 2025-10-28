import fetch from "node-fetch";

// ---- Config ----
const GH_TOKEN = process.env.GH_TOKEN;
const LOGIN = process.env.GH_LOGIN;

// Rango (últimos 12 meses)
const to = new Date();
const from = new Date();
from.setFullYear(to.getFullYear() - 1);

// Helper GraphQL
async function gql(query, variables = {}) {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${GH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await r.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

// 1) Commits, PRs, Orgs (contributionsCollection = últimos 12 meses)
async function getCoreStats() {
  const q = `
    query($login:String!, $from:DateTime!, $to:DateTime!) {
      user(login:$login) {
        id
        organizations(first:100){ totalCount }
        contributionsCollection(from:$from, to:$to) {
          totalCommitContributions
          totalPullRequestContributions
        }
      }
    }
  `;
  const d = await gql(q, { login: LOGIN, from: from.toISOString(), to: to.toISOString() });
  return {
    userId: d.user.id,
    orgs: d.user.organizations.totalCount,
    totalCommits: d.user.contributionsCollection.totalCommitContributions,
    totalPRs: d.user.contributionsCollection.totalPullRequestContributions,
  };
}

// 2) Líneas añadidas/eliminadas y colaboradores (a partir de PRs propios)
async function getPRLinesAndCollaborators() {
  let additions = 0, deletions = 0;
  const collaborators = new Set();
  let hasNext = true, cursor = null;

  while (hasNext) {
    const q = `
      query($login:String!, $after:String) {
        user(login:$login) {
          pullRequests(first:100, after:$after, orderBy:{field:UPDATED_AT, direction:DESC}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              updatedAt
              additions
              deletions
              participants(first:50){ nodes { login } }
            }
          }
        }
      }
    `;
    const d = await gql(q, { login: LOGIN, after: cursor });
    const pr = d.user.pullRequests;
    pr.nodes.forEach(n => {
      const updated = new Date(n.updatedAt);
      if (updated >= from && updated <= to) {
        additions += n.additions;
        deletions += n.deletions;
        n.participants.nodes.forEach(p => collaborators.add(p.login));
      }
    });
    hasNext = pr.pageInfo.hasNextPage;
    cursor = pr.pageInfo.endCursor;
  }

  // eliminarte a ti misma si apareces
  collaborators.delete(LOGIN);
  return { additions, deletions, collaboratorsCount: collaborators.size };
}

// 3) Ramas totales en repos propios (no forks)
async function getTotalBranches() {
  let totalBranches = 0;
  let hasNext = true, cursor = null;

  while (hasNext) {
    const q = `
      query($login:String!, $after:String) {
        user(login:$login) {
          repositories(first:100, after:$after, isFork:false, ownerAffiliations: OWNER, privacy: PUBLIC) {
            pageInfo { hasNextPage endCursor }
            nodes {
              name
              refs(refPrefix:"refs/heads/", first:1) { totalCount }
            }
          }
        }
      }
    `;
    const d = await gql(q, { login: LOGIN, after: cursor });
    const repos = d.user.repositories;
    repos.nodes.forEach(repo => { totalBranches += repo.refs.totalCount; });
    hasNext = repos.pageInfo.hasNextPage;
    cursor = repos.pageInfo.endCursor;
  }
  return totalBranches;
}

// 4) Escribir en README entre marcadores
import fs from "fs";
function updateReadme(block) {
  const path = "README.md";
  const start = "<!-- STATS:START -->";
  const end = "<!-- STATS:END -->";
  let md = fs.readFileSync(path, "utf8");
  const content = `${start}\n${block}\n${end}`;
  if (md.includes(start) && md.includes(end)) {
    md = md.replace(new RegExp(`${start}[\\s\\S]*?${end}`), content);
  } else {
    // Si no existen, lo agregamos al final
    md += `\n\n${content}\n`;
  }
  fs.writeFileSync(path, md);
}

// Run
const core = await getCoreStats();
const prAgg = await getPRLinesAndCollaborators();
const branches = await getTotalBranches();

const table = `
| Metric | Value |
|---|---:|
| **Total commits (last 12 mo.)** | ${core.totalCommits} |
| **Total PRs (last 12 mo.)** | ${core.totalPRs} |
| **Lines added (via PRs)** | ${prAgg.additions} |
| **Lines deleted (via PRs)** | ${prAgg.deletions} |
| **Organizations** | ${core.orgs} |
`;

updateReadme(table);
console.log("Custom stats updated ✅");
