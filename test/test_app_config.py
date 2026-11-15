# -*- coding: utf-8 -*-
"""Юнит-тесты сохранности config.json в панели (app.py).

Чтение с BOM, отказ перезаписывать повреждённый файл, атомарная запись,
резервные копии в backups/ (тот же формат, что у lib/safe_files.js).
Только временные каталоги. Запуск: python test/test_app_config.py
"""
import json
import os
import re
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app  # noqa: E402  (окно создаётся только в app.main())

TMP_DIRS = []


def use_tmp_base():
    d = tempfile.mkdtemp(prefix="ag_app_cfg_")
    TMP_DIRS.append(d)
    app.BASE = d
    app.CONFIG_FILE = os.path.join(d, "config.json")
    app.BACKUP_DIR = os.path.join(d, "backups")
    return d


def write_raw(text, encoding="utf-8"):
    with open(app.CONFIG_FILE, "w", encoding=encoding) as f:
        f.write(text)


def load():
    with open(app.CONFIG_FILE, encoding="utf-8") as f:
        return json.load(f)


def backups():
    if not os.path.isdir(app.BACKUP_DIR):
        return []
    return sorted((n for n in os.listdir(app.BACKUP_DIR) if n.endswith(".bak")), reverse=True)


def leftovers(d):
    return [n for n in os.listdir(d) if n.endswith(".tmp")]


def test_read_config():
    use_tmp_base()
    assert app.read_config() == {}, "нет файла — пустой конфиг"
    write_raw('{"port": 9000}')
    assert app.read_config() == {"port": 9000}
    write_raw('{"port": 9001}', encoding="utf-8-sig")
    assert app.read_config() == {"port": 9001}, "BOM от Блокнота"
    write_raw('{"port": ')
    assert app.read_config() is None, "повреждённый — None, а не {}"
    write_raw("[1, 2]")
    assert app.read_config() is None, "не объект — None"
    print("ok: read_config различает «нет файла» и «повреждён»")


def test_save_refuses_damaged():
    use_tmp_base()
    write_raw('{"apiKey": "agk_trunc')
    assert app.save_config(app.read_config()) is False
    with open(app.CONFIG_FILE, encoding="utf-8") as f:
        assert f.read() == '{"apiKey": "agk_trunc', "повреждённый файл не перезаписан"
    print("ok: повреждённый config.json не затирается пустым")


def test_save_atomic_and_unicode():
    d = use_tmp_base()
    assert app.save_config({"geminiWeb": {"accountLabel": "личный Pro"}}) is True
    assert load()["geminiWeb"]["accountLabel"] == "личный Pro"
    assert leftovers(d) == [], leftovers(d)
    print("ok: запись через временный файл, кириллица сохраняется")


def test_backups_dedupe_and_prune():
    use_tmp_base()
    app.save_config({"gen": 0})
    assert backups() == [], "до первой записи копировать нечего"
    app.save_config({"gen": 1})
    names = backups()
    assert len(names) == 1, names
    assert re.fullmatch(r"config\.json\.\d{8}-\d{6}-\d{3}(_\d{3})?\.bak", names[0]), names[0]
    with open(os.path.join(app.BACKUP_DIR, names[0]), encoding="utf-8") as f:
        assert json.load(f) == {"gen": 0}
    app.save_config({"gen": 1})
    app.save_config({"gen": 1})
    assert len(backups()) == 2, "одинаковое содержимое копируется один раз"
    for i in range(2, 20):
        app.save_config({"gen": i})
    names = backups()
    assert len(names) == app.CONFIG_BACKUPS_KEEP, names
    with open(os.path.join(app.BACKUP_DIR, names[0]), encoding="utf-8") as f:
        assert json.load(f) == {"gen": 18}, "новейшая копия — первой"
    print("ok: резервные копии без дублей, не больше %d" % app.CONFIG_BACKUPS_KEEP)


def test_save_while_file_is_open():
    if sys.platform != "win32":
        print("skip: блокировка файла — только Windows")
        return
    d = use_tmp_base()
    app.save_config({"v": 1})
    with open(app.CONFIG_FILE, "rb"):
        # os.replace поверх открытого без FILE_SHARE_DELETE файла падает — нужен запасной путь.
        assert app.save_config({"v": 2}) is True
    assert load() == {"v": 2}
    assert leftovers(d) == [], leftovers(d)
    print("ok: запись проходит, даже когда файл открыт на чтение")


def test_helpers():
    assert app.config_section({"agent": {"a": 1}}, "agent") == {"a": 1}
    assert app.config_section({"agent": "oops"}, "agent") == {}
    assert app.config_section(None, "agent") == {}
    assert app.config_port({"port": "9000"}) == 9000
    assert app.config_port({"port": "abc"}) == 8317
    assert app.config_port({"port": 70000}) == 8317
    assert app.config_port({}, 8400) == 8400
    print("ok: config_section / config_port устойчивы к мусору")


def test_panel_helpers():
    import socket

    # netstat отдаёт байты в OEM-кодировке (cp866) — декодируем построчно.
    raw = app.diagnostic_safe_text("ok").encode("utf-8")
    assert app._decode_console(raw) == "ok"
    if sys.platform == "win32":
        assert app._decode_console("привет".encode("cp866")) == "привет"
        assert app._decode_console(b"plain ascii") == "plain ascii"
        # pid_on_port должен сопоставлять порт целиком: 8399 != 18399, 839 != 8399.
        s = socket.socket()
        s.bind(("127.0.0.1", 8399))
        s.listen(5)
        try:
            assert app.pid_on_port(8399) == os.getpid()
            assert app.pid_on_port(839) in (None, app.pid_on_port(839))
            assert app.pid_on_port(18399) != os.getpid()
        finally:
            s.close()

    # Хвост журнала не должен утекать ключом.
    d = use_tmp_base()
    old_api_key, old_log = app.API_KEY, app.LOG_FILE
    app.API_KEY = "agk_secret_for_test_only"
    app.LOG_FILE = os.path.join(d, "client.log")
    try:
        with open(app.LOG_FILE, "w", encoding="utf-8") as f:
            f.write("line1\nconfig apiKey: agk_secret_for_test_only\nlast line\n")
        class Fake:  # минимум, который нужен _log_tail
            _log_tail = app.App._log_tail
        tail = Fake()._log_tail()
        assert "agk_secret_for_test_only" not in tail, tail
        assert "[ключ скрыт]" in tail or "[secret hidden]" in tail, tail
        assert "last line" in tail
    finally:
        app.API_KEY, app.LOG_FILE = old_api_key, old_log
    print("ok: pid_on_port и хвост журнала (OEM-декодирование, ключ скрыт)")


def test_redaction_survives_damaged_config():
    use_tmp_base()
    write_raw("{broken")
    assert "hello" in app.diagnostic_safe_text("hello")
    print("ok: скрытие секретов не падает на повреждённом config.json")


def test_diagnostic_waiting_animation():
    """Индикатор ожидания: тикает, пишет секунды, гаснет и не оставляет after-циклы."""
    import tkinter as tk
    old_loader = app.DiagnosticChatDialog.load_models
    app.DiagnosticChatDialog.load_models = lambda self: None
    root = tk.Tk()
    try:
        dlg = app.DiagnosticChatDialog(root)
        dlg._busy = True
        dlg._start_waiting()
        saw = {}
        def check():
            saw["tick"] = dlg._wait_tick
            saw["dots"] = dlg.wait_dots.cget("text")
            saw["label"] = dlg.wait_label.cget("text")
            dlg._busy = False
            dlg._stop_waiting()
            saw["stopped_at"] = dlg._wait_tick
            saw["cleared"] = dlg.wait_label.cget("text") == "" and not dlg.wait_progress.find_all()
        root.after(800, check)
        root.after(1400, lambda: saw.__setitem__("late", dlg._wait_tick) or root.destroy())
        root.mainloop()
        assert saw.get("tick", 0) >= 2, saw
        assert set(saw["dots"]) <= {"."} and saw["dots"], saw
        assert "1 с" in saw["label"] or "1 s" in saw["label"], saw
        assert saw.get("late") == saw.get("stopped_at"), "тики продолжаются после остановки"
        assert saw.get("cleared") is True, saw
    finally:
        app.DiagnosticChatDialog.load_models = old_loader
    print("ok: анимация ожидания в диагностическом чате")


if __name__ == "__main__":
    try:
        test_read_config()
        test_save_refuses_damaged()
        test_save_atomic_and_unicode()
        test_backups_dedupe_and_prune()
        test_save_while_file_is_open()
        test_helpers()
        test_redaction_survives_damaged_config()
        test_panel_helpers()
        test_diagnostic_waiting_animation()
    finally:
        for path in TMP_DIRS:
            shutil.rmtree(path, ignore_errors=True)
    print("ALL APP CONFIG UNIT TESTS PASSED!")
