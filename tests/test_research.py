"""Testes para o serviço de pesquisa complementar (PubMed e NewsAPI)."""
from unittest.mock import patch

from app.services import research


def test_research_pubmed_empty_topic():
    assert research.research_pubmed("") == []
    assert research.research_pubmed("   ") == []


def test_research_pubmed_success():
    fake_esearch = {
        "esearchresult": {"idlist": ["12345"]}
    }
    fake_esummary = {
        "result": {
            "12345": {"title": "Altitude sickness prevention in Andes."}
        }
    }

    with patch("app.services.research.http_get_json", side_effect=[fake_esearch, fake_esummary]):
        res = research.research_pubmed("machu picchu")
        assert len(res) == 1
        assert "[Evidência PubMed] Altitude sickness prevention in Andes" in res[0]


def test_research_pubmed_handles_network_failure():
    with patch("app.services.research.http_get_json", side_effect=TimeoutError("Connection timed out")):
        res = research.research_pubmed("machu picchu")
        assert res == []
