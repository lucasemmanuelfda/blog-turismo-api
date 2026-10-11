"""Testes automatizados da CLI unificada de gerenciamento."""
import os
from unittest.mock import patch

from app import cli
from app.database import Base, SessionLocal, engine


def setup_function():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def test_cli_seed_and_stats(capsys):
    cli.cmd_seed()
    out = capsys.readouterr().out
    assert "Inicializacao concluida com sucesso!" in out
    assert "Roteiros" in out

    cli.cmd_stats()
    stats_out = capsys.readouterr().out
    assert "ESTATISTICAS DO BLOG TURISMO" in stats_out
    assert "Total de posts: 0" in stats_out
    assert "Categorias cadastradas (5)" in stats_out


def test_cli_test_connections(capsys):
    with patch("app.services.images._wikimedia_search", return_value=["https://test.jpg"]):
        cli.cmd_test_connections()
        out = capsys.readouterr().out
        assert "DIAGNOSTICO DE CONEXOES" in out
        assert "[OK] Conexao com banco" in out
        assert "[OK] Wikimedia Commons" in out


def test_cli_publish_due_and_relink(capsys):
    cli.cmd_seed()
    cli.cmd_publish_due()
    out = capsys.readouterr().out
    assert "Posts agendados publicados agora:" in out

    cli.cmd_relink()
    relink_out = capsys.readouterr().out
    assert "Posts atualizados com temas correlacionados:" in relink_out


def test_cli_main_dispatch():
    with patch("sys.argv", ["cli", "stats"]), patch("app.cli.cmd_stats") as mock_stats:
        cli.main()
        mock_stats.assert_called_once()


def test_cli_index_google_dispatch():
    with patch("sys.argv", ["cli", "index-google", "--limit", "10"]), patch("app.cli.cmd_index_google") as mock_index:
        cli.main()
        mock_index.assert_called_once_with(None, None, 10)


def test_cli_refresh_all_images_dispatch():
    with patch("sys.argv", ["cli", "refresh-all-images"]), patch("app.cli.cmd_refresh_all_images") as mock_refresh:
        cli.main()
        mock_refresh.assert_called_once()
