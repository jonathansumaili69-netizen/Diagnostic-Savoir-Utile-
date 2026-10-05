#!/usr/bin/env python3
"""Génération réelle Tiny-SD sur CPU, sans clé ni endpoint d'inférence payant."""

import argparse
import json
import os
import sys
import time
from pathlib import Path

MODEL_ID = "segmind/tiny-sd"
STYLE_SUFFIX = (
    "vertical editorial illustration, semi-realistic, soft natural cinematic light, "
    "navy blue, ivory and muted ochre palette, clean mobile composition, "
    "faceless, no readable text, no logos"
)
NEGATIVE_PROMPT = (
    "people, person, human, visible face, hands, blurry, low quality, "
    "readable text, watermark, logo"
)


def compact_prompt(tokenizer, scene_prompt: str) -> str:
    """Keep the scene-specific subject first, then append a compact art direction."""
    scene_ids = tokenizer(scene_prompt, add_special_tokens=False)["input_ids"]
    style_ids = tokenizer(STYLE_SUFFIX, add_special_tokens=False)["input_ids"]
    max_total = int(tokenizer.model_max_length)
    max_content = max_total - tokenizer.num_special_tokens_to_add(pair=False)
    style_ids = style_ids[:max_content]
    scene_budget = max(0, max_content - len(style_ids))
    token_ids = scene_ids[:scene_budget] + style_ids
    prompt = tokenizer.decode(token_ids, skip_special_tokens=True)
    # Guard against tokenization changes introduced by decoding the prefix.
    while len(tokenizer(prompt, add_special_tokens=True)["input_ids"]) > max_total and scene_budget > 0:
        scene_budget -= 1
        token_ids = scene_ids[:scene_budget] + style_ids
        prompt = tokenizer.decode(token_ids, skip_special_tokens=True)
    return prompt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="JSON generation request")
    parser.add_argument("--output", required=True, help="PNG output path")
    args = parser.parse_args()

    request = json.loads(Path(args.input).read_text(encoding="utf-8"))
    scene_prompt = str(request.get("prompt", "")).strip()
    if not scene_prompt:
        raise ValueError("A non-empty scene prompt is required.")

    width = int(request.get("width", 504))
    height = int(request.get("height", 896))
    steps = int(request.get("steps", 25))
    seed = int(request.get("seed", 1))
    if width < 64 or height < 64 or width % 8 or height % 8:
        raise ValueError("Width and height must be positive multiples of 8.")
    if not 1 <= steps <= 50:
        raise ValueError("Inference steps must be between 1 and 50.")
    if not 0 <= seed <= 2**32 - 1:
        raise ValueError("Seed is outside the supported range.")
    if not os.environ.get("HF_HUB_DISABLE_IMPLICIT_TOKEN"):
        os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"

    import torch
    from diffusers import DiffusionPipeline, DPMSolverMultistepScheduler

    cpu_count = os.cpu_count() or 1
    torch.set_num_threads(max(1, min(int(os.environ.get("TINY_SD_CPU_THREADS", "4")), cpu_count)))
    torch.set_num_interop_threads(1)
    torch.set_grad_enabled(False)

    started = time.perf_counter()
    pipe = DiffusionPipeline.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.float32,
        use_safetensors=False,
        safety_checker=None,
        requires_safety_checker=False,
    )
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config)
    pipe = pipe.to("cpu")
    pipe.set_progress_bar_config(disable=True)
    prompt = compact_prompt(pipe.tokenizer, scene_prompt)

    with torch.inference_mode():
        image = pipe(
            prompt=prompt,
            negative_prompt=NEGATIVE_PROMPT,
            width=width,
            height=height,
            num_inference_steps=steps,
            guidance_scale=7.0,
            generator=torch.Generator(device="cpu").manual_seed(seed),
        ).images[0]

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path, format="PNG", optimize=True)
    print(json.dumps({
        "ok": True,
        "model": MODEL_ID,
        "width": image.width,
        "height": image.height,
        "steps": steps,
        "seed": seed,
        "elapsed_seconds": round(time.perf_counter() - started, 2),
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 - emit a concise, non-secret failure
        print(f"Tiny-SD CPU generation failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
