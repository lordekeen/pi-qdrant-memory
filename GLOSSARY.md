# pi-qdrant-memory

The domain language of the extension: durable conversation knowledge, how it is
captured, and how it is configured. Terms here are the canonical ones —
`AGENTS.md` covers architecture and invariants, `DESIGN.md` the human surfaces.

## Knowledge

**Memory**:
A durable piece of prior conversation knowledge, stored as one point in a
project's collection and retrieved by semantic search. Its text is the product:
every surface shows it verbatim.
_Avoid_: note, document, chunk.

**Memory type**:
The kind of a memory — `decision`, `fact`, `constraint`, `preference`,
`session_summary`, or `code` (code summaries). Retrieval can be restricted to
one type; there is no separate store per type.
_Avoid_: category, tag, class.

**Artifact**:
A durable entry pi-blackhole has produced but not yet handed over — an
observation or a reflection. In mode 1 the extension ingests pending artifacts
at session start.
_Avoid_: item, entry, document.

**Session summary**:
The knowledge a session's compaction produces, captured automatically in mode 2
and stored as one memory of type `session_summary`.
_Avoid_: compaction note, transcript, recap.

**Code summary**:
A structural summary of one exported symbol (or one file anchor) produced by the
scanner, stored as a memory of type `code` with file and symbol provenance. It
is the unit code search and delete-by-file operate on.
_Avoid_: code chunk, code embedding, snippet.

**Source kind**:
The provenance of a stored memory: `remember_tool`, `blackhole_observation`,
`blackhole_reflection`, `own_capture`, or `code_summary`. It is a payload field,
not a user-facing label.
_Avoid_: origin, source.

**Retraction**:
Removing a memory that is now obsolete or contradicted, by exact verbatim text
match and with confirmation. The feature is opt-in.
_Avoid_: forget, delete — those name the command and tool; retraction names the
concept.

## Capture and modes

**pi-blackhole**:
The companion extension that produces durable observations and reflections from
conversations. When it is operational, this extension runs in mode 1 and reads
its pending queue instead of capturing compaction summaries itself.
_Avoid_: blackhole (alone), the other extension.

**Mode 1 / Mode 2**:
How capture happens. Mode 1: pi-blackhole is operational, so the extension
ingests its pending artifacts and never claims the compaction hook. Mode 2: the
extension owns capture and stores the compaction summary. The effective mode
comes from the `mode` setting — `blackhole` forces mode 1, `own` forces mode 2,
`auto` follows detection.
_Avoid_: blackhole mode, capture mode (ambiguous without the number).

## Projects and configuration

**Project**:
The unit a collection and a project override attach to: the nearest git root
above the session's working directory, identified by a stable hash
(`pi-mem-<16 hex>`).
_Avoid_: workspace, repository root, collection.

**Collection**:
The one Qdrant collection holding a single project's memories and code
summaries. The collection name is the project id.
_Avoid_: index, table, namespace.

**Global config**:
The one file holding the global layer: the ten non-allowlisted keys plus the
allowlisted defaults, resolved defaults → file → env.
_Avoid_: settings file, main config.

**Project override**:
An allowlisted value (`codeKnowledge`, `codeScoreThreshold`) stored per project.
It applies only where the environment supplies nothing usable for that field,
and is cleared with the reserved value `default`.
_Avoid_: local settings, project config.

**Effective config**:
What the running session actually uses: env → project override → global file →
built-in defaults, resolved per field. The project layer fills the gap only
where the environment has no usable value.
_Avoid_: resolved config, current config.
