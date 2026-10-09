#!/usr/bin/env python3
"""Single-variant CPU-only Realistic Vision + LCM inference, pinned to HF revisions."""
import argparse
import json
import os
import time
from pathlib import Path

LCM = "latent-consistency/lcm-lora-sdv1-5"
LCM_REV = "cf2fced511dbe7e26c8d1d397e728fbab875db4b"
VARIANTS = {
    "rv4-lcm8": {"base": "SG161222/Realistic_Vision_V4.0_noVAE", "revision": "1685907c0283c7278ba26c5fe561506f564b48d3", "steps": 8},
    "rv4-lcm6": {"base": "SG161222/Realistic_Vision_V4.0_noVAE", "revision": "1685907c0283c7278ba26c5fe561506f564b48d3", "steps": 6},
    "rv51-lcm4": {"base": "SG161222/Realistic_Vision_V5.1_noVAE", "revision": "1e9f017a7b1eaefb63a1900ea6c5953d2739fd21", "steps": 4},
}
GUIDANCE = 1.5
NEGATIVE = "people, person, human, visible face, hands, blurry, low quality, readable text, watermark, logo"

def validate(request):
    prompt = str(request.get("prompt", "")).strip()
    width, height = int(request.get("width", 504)), int(request.get("height", 896))
    seed = int(request.get("seed", 1))
    if not prompt:
        raise ValueError("Prompt d’image absent.")
    if width < 64 or height < 64 or width % 8 or height % 8:
        raise ValueError("Les dimensions doivent être >=64 et multiples de 8.")
    if abs(width / height - 9 / 16) > 0.005:
        raise ValueError("Le générateur strict exige une image verticale 9:16.")
    if seed < 0 or seed > 2**32 - 1:
        raise ValueError("Seed hors plage.")
    return prompt, width, height, seed

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("request")
    parser.add_argument("output")
    parser.add_argument("--variant", required=True, choices=tuple(VARIANTS))
    args = parser.parse_args()
    prompt, width, height, seed = validate(json.loads(Path(args.request).read_text(encoding="utf-8")))
    meta = VARIANTS[args.variant]
    os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    os.environ.setdefault("MKL_NUM_THREADS", "4")
    import torch
    from diffusers import DiffusionPipeline, LCMScheduler
    torch.set_num_threads(max(1, min(int(os.environ.get("RV_LCM_CPU_THREADS", "4")), os.cpu_count() or 1)))
    torch.set_num_interop_threads(1)
    torch.set_grad_enabled(False)
    if torch.cuda.is_available():
        raise RuntimeError("Le provider strict autorise uniquement le CPU.")
    started = time.perf_counter()
    pipe = DiffusionPipeline.from_pretrained(
        meta["base"], revision=meta["revision"], torch_dtype=torch.float32,
        use_safetensors=True, safety_checker=None, requires_safety_checker=False,
        low_cpu_mem_usage=True,
    )
    pipe.scheduler = LCMScheduler.from_config(pipe.scheduler.config)
    pipe.load_lora_weights(LCM, revision=LCM_REV, weight_name="pytorch_lora_weights.safetensors")
    pipe.fuse_lora()
    pipe = pipe.to("cpu")
    pipe.set_progress_bar_config(disable=True)
    with torch.inference_mode():
        image = pipe(prompt=prompt, negative_prompt=NEGATIVE, width=width, height=height,
                     num_inference_steps=meta["steps"], guidance_scale=GUIDANCE,
                     generator=torch.Generator(device="cpu").manual_seed(seed)).images[0]
    if image.size != (width, height):
        raise ValueError(f"Dimensions générées invalides: {image.size}")
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(out_path, format="PNG", optimize=True)
    from PIL import Image
    with Image.open(out_path) as check:
        check.verify()
    print(json.dumps({"ok": True, "variant": args.variant, "base": meta["base"],
        "base_revision": meta["revision"], "lora": LCM, "lora_revision": LCM_REV,
        "steps": meta["steps"], "guidance_scale": GUIDANCE, "scheduler": "LCMScheduler",
        "vae": "repository VAE component", "seed": seed, "width": width, "height": height,
        "elapsed_seconds": round(time.perf_counter() - started, 2), "output": str(out_path)}, separators=(",", ":")), flush=True)

if __name__ == "__main__":
    main()
