import { getStore } from "@netlify/blobs";

// ===== EDIT THIS PART: your election =====
const election = {
  title: "Student Council Election 2026",
  description: "Choose one candidate for each position. Your vote is final once submitted.",
  // [] = any student number can vote. Or list allowed ones: ["2024101159", "2024101160"]
  allowedStudents: [],
  positions: [
    { id: "president", title: "President", candidates: [
      { id: "president-1", name: "Juan Dela Cruz", tagline: "Bigger events, fewer fees." },
      { id: "president-2", name: "Maria Santos", tagline: "A louder student voice." } ] },
    { id: "vice-president", title: "Vice President", candidates: [
      { id: "vp-1", name: "Pedro Reyes", tagline: "" },
      { id: "vp-2", name: "Ana Lopez", tagline: "" } ] },
    { id: "secretary", title: "Secretary", candidates: [
      { id: "sec-1", name: "Carlo Mendoza", tagline: "" },
      { id: "sec-2", name: "Bea Villanueva", tagline: "" } ] }
  ]
};
// ===== END OF EDIT PART =====

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status,
    headers: { "content-type": "application/json", "cache-control": "no-store" } });
const isNo = (s) => /^\d{6,12}$/.test(s);
const getStatus = async () => ((await getStore("settings").get("status")) === "closed" ? "closed" : "open");

async function readVotes(votes) {
  const out = [];
  for await (const page of votes.list({ paginate: true })) {
    const recs = await Promise.all(page.blobs.map((b) => votes.get(b.key, { type: "json" })));
    for (const r of recs) if (r) out.push(r);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, "");
  const votes = getStore("votes");

  if (route === "/api/config") {
    return json({ title: election.title, description: election.description,
      status: await getStatus(), positions: election.positions });
  }

  if (route === "/api/check") {
    const no = (url.searchParams.get("studentNo") || "").trim();
    if (!isNo(no)) return json({ error: "Enter a valid student number (digits only)." }, 400);
    const allowed = !election.allowedStudents.length || election.allowedStudents.includes(no);
    return json({ allowed, voted: !!(await votes.get(no)) });
  }

  if (route === "/api/vote") {
    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
    let body; try { body = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    const no = String(body.studentNo || "").trim();
    if (name.length < 2 || name.length > 80) return json({ error: "Enter your full name." }, 400);
    if (!isNo(no)) return json({ error: "Enter a valid student number (digits only)." }, 400);
    if ((await getStatus()) !== "open") return json({ error: "Voting is closed." }, 403);
    if (election.allowedStudents.length && !election.allowedStudents.includes(no))
      return json({ error: "This student number is not on the voter list." }, 403);
    const choices = {};
    for (const pos of election.positions) {
      const c = body.choices?.[pos.id];
      if (c == null || c === "abstain") choices[pos.id] = "abstain";
      else if (pos.candidates.some((x) => x.id === c)) choices[pos.id] = c;
      else return json({ error: `Invalid choice for ${pos.title}.` }, 400);
    }
    if (await votes.get(no)) return json({ error: "This student number has already voted." }, 409);
    const ref = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    const res = await votes.setJSON(no, { name, studentNo: no, choices, ref, at: new Date().toISOString() },
      { onlyIfNew: true });
    if (res && res.modified === false) return json({ error: "This student number has already voted." }, 409);
    return json({ ok: true, ref });
  }

  if (route === "/api/results") {
    const pw = process.env.ADMIN_PASSWORD;
    if (!pw) return json({ error: "ADMIN_PASSWORD is not set. Add it in Netlify > Site configuration > Environment variables, then redeploy." }, 500);
    if (req.headers.get("x-admin-password") !== pw) return json({ error: "Wrong admin password." }, 401);

    if (req.method === "POST") {
      let body = {}; try { body = await req.json(); } catch {}
      if (body.action === "open" || body.action === "close") {
        await getStore("settings").set("status", body.action === "open" ? "open" : "closed");
        return json({ ok: true });
      }
      if (body.action === "reset") {
        if (body.confirm !== "RESET") return json({ error: "Type RESET to confirm." }, 400);
        for await (const page of votes.list({ paginate: true }))
          await Promise.all(page.blobs.map((b) => votes.delete(b.key)));
        return json({ ok: true });
      }
      return json({ error: "Unknown action." }, 400);
    }

    const voters = await readVotes(votes);
    const tallies = election.positions.map((pos) => {
      const counts = Object.fromEntries(pos.candidates.map((c) => [c.id, 0]));
      let abstain = 0;
      for (const v of voters) { const c = v.choices[pos.id]; if (c in counts) counts[c]++; else abstain++; }
      return { id: pos.id, title: pos.title, abstain,
        candidates: pos.candidates.map((c) => ({ id: c.id, name: c.name, votes: counts[c.id] })) };
    });
    return json({ status: await getStatus(), title: election.title, total: voters.length, tallies,
      positions: election.positions, voters });
  }

  return json({ error: "Not found." }, 404);
};

export const config = { path: "/api/*" };
