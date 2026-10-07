/**
 * Read-only check of the platforms' change logs as Pilotage reads them: prints
 * what would be stored for one Meta account and one Google Ads customer.
 * Writes nothing.
 *   npx tsx --env-file=.env.local scripts/pilot-changes-dry-run.ts <metaAccountDigits> <googleCustomerDigits> [days]
 */
import { getMetaSystemToken, metaGraphGetAll } from "@/lib/meta-api";
import { relayDirectTool } from "@/lib/relay-tool";
import { extractRows } from "@/lib/dashboard-widgets";
import { fromGoogleChangeEvent, fromMetaActivity, groupSessions, type ChangeDraft, type GoogleChangeRow, type MetaActivity } from "@/lib/pilot/changes";

async function main() {
  const [meta, google, daysArg] = process.argv.slice(2);
  const days = Number(daysArg) || 28;
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const show = (drafts: ChangeDraft[]) => {
    const sessions = groupSessions(drafts.map((d, i) => ({ ...d, id: String(i), at: d.at })));
    console.log(`  ${drafts.length} changements, ${sessions.length} sessions, ${drafts.filter((d) => d.significant).length} significatifs`);
    const bySource: Record<string, number> = {};
    for (const d of drafts) bySource[`${d.source} via ${d.via}`] = (bySource[`${d.source} via ${d.via}`] ?? 0) + 1;
    console.log("  ", bySource);
    const byField: Record<string, number> = {};
    for (const d of drafts) byField[d.field] = (byField[d.field] ?? 0) + 1;
    console.log("  ", byField);
    for (const s of sessions.slice(0, 8)) {
      console.log(`  ▸ ${s[0].at.toISOString()} ${s[0].actorName} (${s[0].source} via ${s[0].via}) — ${s.length} changement(s)`);
      for (const c of s.slice(0, 5)) console.log(`      ${c.significant ? "!" : " "} ${c.line}`);
    }
  };
  if (meta) {
    const t0 = Date.now();
    const res = await metaGraphGetAll<MetaActivity>(`/act_${meta}/activities`, getMetaSystemToken(), {
      fields: "event_type,event_time,object_type,object_name,object_id,actor_name,actor_id,application_name,extra_data",
      since: String(Math.floor(since.getTime() / 1000)), until: String(Math.ceil(now.getTime() / 1000)), limit: "500",
    }, 2000);
    console.log(`Meta act_${meta}: ${res.data.length} activités lues en ${Date.now() - t0} ms, tronqué=${res.truncated}`);
    const types: Record<string, number> = {};
    for (const a of res.data) types[String(a.event_type)] = (types[String(a.event_type)] ?? 0) + 1;
    console.log("  event_types:", types);
    show(res.data.map((a) => fromMetaActivity(meta, "EUR", a)).filter((d): d is ChangeDraft => !!d));
  }
  if (google) {
    const t0 = Date.now();
    const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
    const query = `SELECT change_event.resource_name, change_event.change_date_time, change_event.change_resource_type, change_event.change_resource_name, change_event.resource_change_operation, change_event.changed_fields, change_event.user_email, change_event.client_type, change_event.old_resource, change_event.new_resource, campaign.id, campaign.name, ad_group.id, ad_group.name FROM change_event WHERE change_event.change_date_time >= '${fmt(since)}' AND change_event.change_date_time <= '${fmt(now)}' ORDER BY change_event.change_date_time DESC LIMIT 3000`;
    const rows = extractRows(await relayDirectTool("mcp-google-ads.Custom_GAQL_Query", { input: JSON.stringify({ customer_id: google, gaql_query: query }) }, 40_000)) as GoogleChangeRow[];
    console.log(`Google ${google}: ${rows.length} événements lus en ${Date.now() - t0} ms`);
    show(rows.flatMap((r) => fromGoogleChangeEvent(google, "EUR", r)));
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
