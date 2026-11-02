"""Testes para o serviço de imagens e validação ativa de URLs."""
from unittest.mock import MagicMock, patch
import urllib.error

from app.services import images


def test_is_valid_travel_photo():
    # Rejeita mapas e gráficos
    assert not images._is_valid_travel_photo("Map of Bonito MS", "image/jpeg", "https://commons.wikimedia.org/thumb/map.jpg")
    assert not images._is_valid_travel_photo("Brasão do Município", "image/jpeg", "https://commons.wikimedia.org/thumb/brasao.jpg")
    assert not images._is_valid_travel_photo("Diagram of River", "image/jpeg", "https://commons.wikimedia.org/thumb/dia.jpg")

    # Rejeita formatos não suportados
    assert not images._is_valid_travel_photo("Foto da Cachoeira", "image/tiff", "https://commons.wikimedia.org/thumb/c.tif")
    assert not images._is_valid_travel_photo("Foto da Cachoeira", "image/svg+xml", "https://commons.wikimedia.org/thumb/c.svg")

    # Aceita foto real em JPG
    assert images._is_valid_travel_photo("Cachoeira Boca da Onça", "image/jpeg", "https://commons.wikimedia.org/thumb/cachoeira.jpg")


def test_is_image_url_live_success():
    images.is_image_url_live.cache_clear()
    mock_resp = MagicMock()
    mock_resp.status = 200
    mock_resp.headers = {"Content-Type": "image/jpeg"}
    mock_resp.__enter__.return_value = mock_resp

    with patch("urllib.request.urlopen", return_value=mock_resp):
        assert images.is_image_url_live("https://upload.wikimedia.org/test.jpg") is True


def test_is_image_url_live_http_404():
    images.is_image_url_live.cache_clear()
    error = urllib.error.HTTPError(
        url="https://upload.wikimedia.org/notfound.jpg",
        code=404,
        msg="Not Found",
        hdrs={},
        fp=None,
    )
    with patch("urllib.request.urlopen", side_effect=error):
        assert images.is_image_url_live("https://upload.wikimedia.org/notfound.jpg") is False


def test_is_image_url_live_empty_and_invalid():
    assert images.is_image_url_live("") is False
    assert images.is_image_url_live("ftp://invalid.com/test.jpg") is False


def test_extract_clean_keyword():
    assert images._extract_clean_keyword("Roteiro completo em Bonito MS") == "bonito"
    assert images._extract_clean_keyword("Guia definitivo de Gramado e Canela") == "gramado canela"
    assert images._extract_clean_keyword("", tags=["praia do forte"]) == "praia do forte"
