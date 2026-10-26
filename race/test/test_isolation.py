"""The suite never touches a developer's RACE_DB (conftest.py points it at a scratch directory first)."""
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))

import conftest  # noqa: E402


def test_the_suite_database_is_the_scratch_one_whatever_the_environment_said():
    import app as appmod        # imported here: the other modules set app's env knobs before they import it
    assert os.path.dirname(appmod.DB_PATH) == conftest.SCRATCH_DIR
    assert os.environ["RACE_DB"] == os.path.join(conftest.SCRATCH_DIR, "race.db")


def test_race_db_is_an_empty_tmp_path_database_with_the_schema(race_db, tmp_path):
    import app as appmod
    assert race_db == appmod.DB_PATH and os.path.dirname(race_db) == str(tmp_path)
    with sqlite3.connect(race_db) as conn:
        assert conn.execute("SELECT COUNT(*) FROM runs").fetchone() == (0,)
        assert conn.execute("SELECT COUNT(*) FROM pilots").fetchone() == (0,)
        assert conn.execute("SELECT COUNT(*) FROM gungame_games").fetchone() == (0,)
