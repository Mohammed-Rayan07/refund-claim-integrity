# FraudBench subset — consumed, never generated

This directory holds a **locally provided** subset of the publicly released
FraudBench benchmark (HuggingFace `TristanYan/FraudBench`, arXiv 2605.08820,
NTU + Alibaba), published for academic research on **detection**.

Per [SPEC.md §0](../../SPEC.md), RCIE consumes adversarial samples only. Nothing in
this repository generates, edits, augments or synthesises evidence — `loader.ts`
reads a manifest and nothing else.

**No manifest is committed here.** Fabricating benchmark entries would make the
evaluation meaningless, so when the dataset is absent the loader reports an empty
subset and the pipeline runs on synthetic business fixtures alone. The demo prints
the subset status line either way.

## Adding your local copy

1. Obtain the benchmark from its published source.
2. Write `manifest.json` in this directory (or anywhere, and set `FRAUDBENCH_PATH`)
   as a JSON array:

```json
[
  {
    "sample_id": "<benchmark-assigned id>",
    "image_ref": "<path or URI within your local copy>",
    "label": "authentic",
    "generator": null
  },
  {
    "sample_id": "<benchmark-assigned id>",
    "image_ref": "<path or URI within your local copy>",
    "label": "synthetic",
    "generator": "<generator name as published>"
  }
]
```

`generator` drives the F10 unseen-generator holdout split in Chunk 3.

3. Point at it if it lives elsewhere:

```bash
FRAUDBENCH_PATH=/path/to/fraudbench MODE=mock npm run demo:decide
```

Malformed entries are dropped, never guessed at.
