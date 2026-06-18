from pathlib import Path

from huggingface_hub import snapshot_download


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "mlx-community/pyannote-segmentation-3.0-mlx"
TARGET_DIR = PROJECT_ROOT / "models" / "pyannote-segmentation-3.0-mlx"


def main() -> None:
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=MODEL_ID,
        local_dir=TARGET_DIR,
        allow_patterns=["weights.npz", "config.json", "README.md", ".gitattributes"],
    )
    print(f"Downloaded {MODEL_ID} to {TARGET_DIR}")


if __name__ == "__main__":
    main()
