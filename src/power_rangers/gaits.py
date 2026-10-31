"""Paired-gait limits shared with the TypeScript actors through gaits.json."""
import json
from pathlib import Path

PAIRED_PROFILES = json.loads(Path(__file__).with_name('gaits.json').read_text())


def paired_profile(profile):
    if profile not in PAIRED_PROFILES:
        raise ValueError('Unknown paired motion profile')
    return PAIRED_PROFILES[profile]
