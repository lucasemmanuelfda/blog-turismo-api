"""Testes para o serviço de Google Trends e candidatos diários."""
from unittest.mock import MagicMock, patch
import pandas as pd

from app.services.trends import TrendService, SEED_TOPICS


def test_trends_dedupe():
    items = ["Roteiro em Bonito MS", "roteiro em bonito ms", "Trilhas Chapada"]
    deduped = TrendService._dedupe(items)
    # Primeiro termo preservado, duplicatas removidas
    assert len(deduped) == 2
    assert deduped[0] == "Roteiro em Bonito MS"
    assert deduped[1] == "Trilhas Chapada"


def test_google_trends_rising_and_top_extraction(tmp_path):
    svc = TrendService(path=str(tmp_path / "trends.json"))

    mock_df_rising = pd.DataFrame({"query": ["arraial do cabo pousadas", "maragogi resort"]})
    mock_df_top = pd.DataFrame({"query": ["melhores praias brasil"]})
    mock_frame = {"rising": mock_df_rising, "top": mock_df_top}

    mock_pt = MagicMock()
    mock_pt.related_queries.return_value = {"viagem turismo": mock_frame}

    with patch("pytrends.request.TrendReq", return_value=mock_pt):
        results = svc._google_trends("BR", n=5)
        assert len(results) == 3
        assert "arraial do cabo pousadas" in results
        assert "maragogi resort" in results
        assert "melhores praias brasil" in results


def test_google_trends_fallback_keyword_when_first_empty(tmp_path):
    svc = TrendService(path=str(tmp_path / "trends.json"))

    mock_pt = MagicMock()
    # Primeiro keyword retorna vazio, segundo retorna dados
    mock_df = pd.DataFrame({"query": ["campos do jordao no inverno"]})
    mock_pt.related_queries.side_effect = [
        {"viagem turismo": {}},
        {"viagem": {"top": mock_df}}
    ]

    with patch("pytrends.request.TrendReq", return_value=mock_pt):
        results = svc._google_trends("BR", n=5)
        assert len(results) == 1
        assert "campos do jordao no inverno" in results


def test_trends_database_persistence(tmp_path):
    from app.database import Base, SessionLocal, engine
    from app.models import AppSetting
    from app.services.trends import TRENDS_SETTING_KEY

    Base.metadata.create_all(bind=engine)
    p = str(tmp_path / "trends.json")
    svc = TrendService(path=p)
    svc.data["2026-11-02"] = ["destinos nordeste", "trilhas minas"]
    svc._save()

    with SessionLocal() as db:
        row = db.get(AppSetting, TRENDS_SETTING_KEY)
        assert row is not None
        assert "destinos nordeste" in row.value

    # Simula reinício sem o arquivo local
    svc2 = TrendService(path=str(tmp_path / "inexistente.json"))
    assert "2026-11-02" in svc2.data
    assert "destinos nordeste" in svc2.data["2026-11-02"]

