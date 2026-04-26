/**
 * GitHub API client for reading/writing the encrypted database.
 *
 * Read:  raw.githubusercontent.com (binary, no base64 overhead for 57MB file)
 * Write: Git Data API (blobs → tree → commit → update ref) for large files
 */

window.ICS = window.ICS || {};

const _GH_API = "https://api.github.com";

function _ghHeaders(token) {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
  };
}

function _detectRepo() {
  const host = location.hostname;
  const path = location.pathname;
  if (host.endsWith(".github.io")) {
    const owner = host.replace(".github.io", "");
    const repo = path.split("/").filter(Boolean)[0];
    if (owner && repo) return { owner, repo };
  }
  return null;
}

async function _getLatestCommitSha(owner, repo, branch, token) {
  const res = await fetch(
    `${_GH_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
    { headers: _ghHeaders(token) }
  );
  if (res.status === 404) {
    throw new Error(`Branch '${branch}' not found. Has the workflow run at least once?`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.object.sha;
}

async function _fetchEncryptedDB(owner, repo, branch, token) {
  // 1) Get commit SHA + tree
  const commitSha = await _getLatestCommitSha(owner, repo, branch, token);

  // 2) Walk commit → tree → data/ subtree to find the DB file
  const commitRes = await fetch(
    `${_GH_API}/repos/${owner}/${repo}/git/commits/${commitSha}`,
    { headers: _ghHeaders(token) }
  );
  if (!commitRes.ok) throw new Error(`Failed to get commit: ${commitRes.status}`);
  const treeSha = (await commitRes.json()).tree.sha;

  const treeRes = await fetch(
    `${_GH_API}/repos/${owner}/${repo}/git/trees/${treeSha}`,
    { headers: _ghHeaders(token) }
  );
  if (!treeRes.ok) throw new Error(`Failed to get tree: ${treeRes.status}`);
  const treeData = await treeRes.json();

  const dataEntry = treeData.tree.find((e) => e.path === "data" && e.type === "tree");
  if (!dataEntry) throw new Error("'data/' directory not found on data branch.");

  const subTreeRes = await fetch(
    `${_GH_API}/repos/${owner}/${repo}/git/trees/${dataEntry.sha}`,
    { headers: _ghHeaders(token) }
  );
  if (!subTreeRes.ok) throw new Error(`Failed to get data/ tree: ${subTreeRes.status}`);
  const subTree = await subTreeRes.json();

  // Try compressed format first, then legacy
  var fileEntry = subTree.tree.find((e) => e.path === "icourse.db.gz.enc");
  var compressed = !!fileEntry;
  if (!fileEntry) {
    fileEntry = subTree.tree.find((e) => e.path === "icourse.db.enc");
  }
  if (!fileEntry) throw new Error("Database file not found on data branch.");

  // 3) Download blob as raw binary
  const blobRes = await fetch(
    `${_GH_API}/repos/${owner}/${repo}/git/blobs/${fileEntry.sha}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.raw",
      },
    }
  );
  if (!blobRes.ok) throw new Error(`Failed to download blob: ${blobRes.status}`);
  const buffer = await blobRes.arrayBuffer();
  return { data: new Uint8Array(buffer), commitSha, compressed };
}

async function _pushEncryptedDB(
  owner, repo, branch, token, bytes, parentSha,
  message = "Update database via web editor"
) {
  const hdrs = { ..._ghHeaders(token), "Content-Type": "application/json" };

  // 1) Create blob
  const base64 = _uint8ToBase64(bytes);
  const blobRes = await fetch(`${_GH_API}/repos/${owner}/${repo}/git/blobs`, {
    method: "POST", headers: hdrs,
    body: JSON.stringify({ content: base64, encoding: "base64" }),
  });
  if (!blobRes.ok) throw new Error(`Failed to create blob: ${blobRes.status}`);
  const blobSha = (await blobRes.json()).sha;

  // 2) Create tree
  const treeRes = await fetch(`${_GH_API}/repos/${owner}/${repo}/git/trees`, {
    method: "POST", headers: hdrs,
    body: JSON.stringify({
      tree: [{ path: "data/icourse.db.gz.enc", mode: "100644", type: "blob", sha: blobSha }],
    }),
  });
  if (!treeRes.ok) throw new Error(`Failed to create tree: ${treeRes.status}`);
  const treeSha = (await treeRes.json()).sha;

  // 3) Create commit
  const commitRes = await fetch(`${_GH_API}/repos/${owner}/${repo}/git/commits`, {
    method: "POST", headers: hdrs,
    body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
  });
  if (!commitRes.ok) throw new Error(`Failed to create commit: ${commitRes.status}`);
  const newCommitSha = (await commitRes.json()).sha;

  // 4) Update ref
  const refRes = await fetch(
    `${_GH_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    { method: "PATCH", headers: hdrs, body: JSON.stringify({ sha: newCommitSha }) }
  );
  if (refRes.status === 422) {
    throw new Error("Conflict: the database was updated by another source. Please refresh and try again.");
  }
  if (!refRes.ok) throw new Error(`Failed to update ref: ${refRes.status}`);
  return newCommitSha;
}

function _uint8ToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

async function _triggerExportWorkflow(
  owner, repo, ref, token, courseId, exportPdf, subIds
) {
  // Fires the existing .github/workflows/export.yml workflow_dispatch.
  // The workflow runs scripts/export_course.py (WeasyPrint) and emails
  // the resulting PDF to RECEIVER_EMAIL — same output the user gets when
  // triggering the workflow manually from the Actions UI.
  //
  // Requires the PAT to grant Actions: Write (in addition to Contents:RW).
  const url = `${_GH_API}/repos/${owner}/${repo}/actions/workflows/export.yml/dispatches`;
  const payload = {
    ref,
    inputs: {
      course_id: String(courseId),
      export_pdf: !!exportPdf,
      sub_ids: subIds || "",
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { ..._ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 204) return; // success — workflow_dispatch returns 204 No Content
  const body = await res.text();
  if (res.status === 403 || res.status === 404) {
    throw new Error(
      "无法触发导出 workflow。请确认你的 GitHub PAT 已开启 " +
      "Actions: Read and write 权限（Contents 权限不足以触发 workflow）。" +
      `服务端返回：${res.status} ${body}`
    );
  }
  if (res.status === 422) {
    throw new Error(
      "触发失败 (422)：通常是 inputs 不匹配 workflow 定义，或 export.yml " +
      `不存在于指定分支 '${ref}'。服务端返回：${body}`
    );
  }
  throw new Error(`GitHub API error ${res.status}: ${body}`);
}

window.ICS.github = {
  detectRepo: _detectRepo,
  getLatestCommitSha: _getLatestCommitSha,
  fetchEncryptedDB: _fetchEncryptedDB,
  pushEncryptedDB: _pushEncryptedDB,
  triggerExportWorkflow: _triggerExportWorkflow,
};
