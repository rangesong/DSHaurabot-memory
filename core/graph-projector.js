import { clone, fields, integer, MEMORY_KINDS, MEMORY_REGIONS, oneOf, REGION_IDS, requireThat, stringList, validateSnapshot, WORKING_REGIONS } from './model.js';

const memoryNodeId = (id) => `memory:${encodeURIComponent(id)}`;
const sourceNodeId = (id) => `source:${encodeURIComponent(id)}`;

function badges(memory) {
  const result = [];
  if (memory.review_status === 'needs_review') result.push({ kind: 'review', label: '待复核' });
  if (memory.validity !== 'current') result.push({ kind: 'validity', label: { historical: '历史适用', superseded: '已被更新', withdrawn: '已撤回' }[memory.validity] });
  if (memory.evidence_status === 'inferred') result.push({ kind: 'evidence', label: '推断，需看依据' });
  if (memory.evidence_status === 'hypothetical') result.push({ kind: 'evidence', label: '假设或示例' });
  if (memory.kind === 'method') result.push({ kind: 'verification', label: { untested: '未试过', tried: '尝试过', verified: '在指定条件下验证', obsolete: '方法已过时', withdrawn: '方法已撤回' }[memory.attributes.verification] });
  if (memory.kind === 'open_loop') result.push({ kind: 'open_loop', label: { proposed: '待决定', active: '进行中', waiting: '等待结果', blocked: '暂时受阻', completed: '已完成', cancelled: '已取消', superseded: '已替代' }[memory.attributes.status] });
  return result;
}

/** Read-only semantic projection. No layout, random activation, or memory strengthening. */
export function projectGraph(snapshot, options = {}) {
  validateSnapshot(snapshot);
  fields(options, ['limit', 'region_ids', 'kinds', 'include_projections', 'include_sources', 'include_noncurrent'], 'graph options');
  const { limit = 300, region_ids = [], kinds = [], include_projections = true, include_sources = false, include_noncurrent = false } = options;
  integer(limit, 'limit'); stringList(region_ids, 'region_ids'); stringList(kinds, 'kinds');
  region_ids.forEach((id) => oneOf(id, REGION_IDS, 'region_ids')); kinds.forEach((kind) => oneOf(kind, MEMORY_KINDS, 'kinds'));
  for (const value of [include_projections, include_sources, include_noncurrent]) requireThat(typeof value === 'boolean', 'INVALID_DATA', 'Graph switches must be boolean');
  const regions = [...WORKING_REGIONS, ...MEMORY_REGIONS];
  const nodes = regions.map((region) => ({ id: `region:${region.id}`, canonical_id: null, node_type: 'region', kind: region.domain, region_id: region.id, label: region.label, description: region.description, color: region.color }));
  nodes.push({ id: 'store:U', canonical_id: null, node_type: 'store', kind: 'canonical_store', label: '统一记忆底座', description: '原话、完整经历和准确版本都在这里' });
  const edges = MEMORY_REGIONS.map((region) => ({ id: `store-entry:${region.id}`, from: `region:${region.id}`, to: 'store:U', relation_type: 'store_entry', layer: 'organization' }));
  const eligible = snapshot.memories.filter((memory) => (include_noncurrent || memory.validity === 'current')
    && (!region_ids.length || memory.region_ids.some((id) => region_ids.includes(id))) && (!kinds.length || kinds.includes(memory.kind)))
    .sort((a, b) => a.recorded_at - b.recorded_at || a.id.localeCompare(b.id));
  const visible = eligible.slice(0, limit);
  const visibleIds = new Set(visible.map((memory) => memory.id));
  const visibleSources = new Set();
  let projectionCount = 0;
  for (const memory of visible) {
    const node = { id: memoryNodeId(memory.id), canonical_id: memory.id, node_type: 'memory', kind: memory.kind, label: memory.label,
      revision: memory.revision, primary_region: memory.primary_region, region_ids: [...memory.region_ids],
      recorded_at: memory.recorded_at, updated_at: memory.updated_at, occurred_at: memory.occurred_at, time_precision: memory.time_precision,
      protection: memory.protection, validity: memory.validity, review_status: memory.review_status, evidence_status: memory.evidence_status,
      source_refs: [...memory.source_refs], badges: badges(memory), activation: null,
      subregion: memory.kind === 'method' ? 'methods' : memory.kind === 'knowledge' ? 'concepts' : null };
    nodes.push(node);
    edges.push({ id: `member:${memory.id}:${memory.primary_region}`, from: node.id, to: `region:${memory.primary_region}`, relation_type: 'member_of', layer: 'organization' });
    if (include_projections) for (const regionId of memory.region_ids) {
      if (regionId === memory.primary_region) continue;
      const id = `projection:${encodeURIComponent(memory.id)}:${regionId}`;
      nodes.push({ ...clone(node), id, node_type: 'projection', primary_region: regionId, projection_of: node.id }); projectionCount++;
      edges.push({ id: `member:${memory.id}:${regionId}`, from: id, to: `region:${regionId}`, relation_type: 'member_of', layer: 'organization' });
      edges.push({ id: `alias:${memory.id}:${regionId}`, from: id, to: node.id, relation_type: 'same_object_entry', layer: 'projection' });
    }
    for (const sourceId of memory.source_refs) visibleSources.add(sourceId);
  }
  for (const relation of snapshot.relations) {
    if (!visibleIds.has(relation.from_id) || !visibleIds.has(relation.to_id)) continue;
    edges.push({ id: `relation:${encodeURIComponent(relation.id)}`, from: memoryNodeId(relation.from_id), to: memoryNodeId(relation.to_id),
      canonical_id: relation.id, relation_type: relation.relation_type, layer: 'content', strength: relation.strength, source_refs: [...relation.source_refs] });
  }
  if (include_sources) {
    for (const source of snapshot.sources) if (visibleSources.has(source.id)) nodes.push({ id: sourceNodeId(source.id), canonical_id: source.id,
      node_type: 'source', kind: source.role, label: `原话 · 第 ${source.sequence} 条`, revision: source.revision,
      recorded_at: source.recorded_at, occurred_at: source.occurred_at, time_precision: source.time_precision });
    for (const memory of visible) for (const sourceId of memory.source_refs) edges.push({ id: `source-ref:${encodeURIComponent(memory.id)}:${encodeURIComponent(sourceId)}`,
      from: memoryNodeId(memory.id), to: sourceNodeId(sourceId), relation_type: 'source_reference', layer: 'evidence' });
  }
  const regionCounts = Object.fromEntries(MEMORY_REGIONS.map((region) => [region.id, visible.filter((memory) => memory.region_ids.includes(region.id)).length]));
  return { schema_version: 1, context: clone(snapshot.context), sequence: snapshot.sequence, recorded_at: snapshot.recorded_at,
    nodes, edges, regions: clone(regions),
    counts: { available_objects: snapshot.memories.length, matching_objects: eligible.length, unique_objects: visible.length,
      experiences: visible.filter((item) => item.kind === 'experience').length, projections: projectionCount,
      source_nodes: include_sources ? visibleSources.size : 0, region_anchors: 10, store_anchors: 1, region_memberships: regionCounts },
    complete: visible.length === eligible.length, omitted_count: eligible.length - visible.length,
    omitted_reason: visible.length === eligible.length ? null : 'display_limit',
    coverage: { kind: 'committed_versions', through_sequence: snapshot.sequence },
  };
}
