"""Targeted checks for storyboard validation and local draft persistence."""

import pytest

from octop.infra.product_library.llm_video_planner import validate_script
from octop.infra.product_library.video_drafts import load_draft, save_draft
from octop.infra.product_library.video_planner import VideoPlanRequest, build_video_plan


def snapshot():
    return {
        "product": {"name": "Bag", "model": "", "selling_points": ["Capacity"]},
        "assets": [
            {
                "id": "a1",
                "filename": "bag.jpg",
                "media_type": "image/jpeg",
                "usage": "scene",
                "priority": 1,
            }
        ],
    }


def test_validate_and_save_confirmed_storyboard(tmp_path):
    snap = snapshot()
    req = VideoPlanRequest(format="portrait", instructions="Show capacity")
    plan = build_video_plan(snap, req)
    script = validate_script(plan["script"], snap, req)
    result = save_draft(tmp_path, 7, "project1", snap, req, script, confirmed=True)
    assert result["confirmed"]
    assert load_draft(tmp_path, 7, "project1")["script"] == script
    assert load_draft(tmp_path, 8, "project1") is None


def test_reject_foreign_asset(tmp_path):
    snap = snapshot()
    req = VideoPlanRequest()
    script = build_video_plan(snap, req)["script"]
    image = next(s for s in script["scenes"] if s["type"] == "image")
    image["asset"] = "../../other-user/private.jpg"
    with pytest.raises(ValueError):
        save_draft(tmp_path, 7, "project1", snap, req, script)


def test_reject_invalid_duration_and_duplicate_ids():
    snap = snapshot()
    req = VideoPlanRequest()
    script = build_video_plan(snap, req)["script"]
    script["scenes"][0]["duration"] = 999
    with pytest.raises(ValueError):
        validate_script(script, snap, req)
    script["scenes"][0]["duration"] = 3
    script["scenes"][1]["id"] = script["scenes"][0]["id"]
    with pytest.raises(ValueError):
        validate_script(script, snap, req)


def test_bgm_choice_is_persisted_and_defaults_on(tmp_path):
    snap = snapshot()
    req = VideoPlanRequest()
    script = validate_script(build_video_plan(snap, req)["script"], snap, req)

    plain = save_draft(tmp_path, 7, "pplain", snap, req, script)
    assert plain["bgm_enabled"] is True
    assert plain["bgm_id"] == ""

    muted = save_draft(tmp_path, 7, "pmuted", snap, req, script, bgm_enabled=False)
    assert muted["bgm_enabled"] is False
    assert load_draft(tmp_path, 7, "pmuted")["bgm_enabled"] is False

    save_draft(tmp_path, 7, "ppicked", snap, req, script, bgm_id="33")
    assert load_draft(tmp_path, 7, "ppicked")["bgm_id"] == "33"
