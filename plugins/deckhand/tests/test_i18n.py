"""Tests for bin/i18n.py and the messages of every script. Run: python3 -m unittest discover -s tests -p 'test_*.py'"""
import glob
import importlib.util
import os
import re
import shutil
import string
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, '..', 'bin')

spec = importlib.util.spec_from_file_location('deckhand_i18n_under_test', os.path.join(BIN, 'i18n.py'))
i18n = importlib.util.module_from_spec(spec)
spec.loader.exec_module(i18n)

# A message key as a string literal ('sub5.state.merged'), not a file name ('sub5.py').
KEY_LITERAL = re.compile(r"""['"]((?:language|common|delegate|sub5|handoff|threads)\.(?!py['"])[a-z_]+(?:\.[a-z_]+)*)['"]""")


def fields(text):
    return sorted(name for _, name, _, _ in string.Formatter().parse(text) if name is not None)


def script_sources():
    """{file name: source} of the scripts, without handoff-state.py's copy of the English messages."""
    out = {}
    for path in sorted(glob.glob(os.path.join(BIN, '*.py'))):
        with open(path, encoding='utf-8') as handle:
            text = handle.read()
        if os.path.basename(path) == 'handoff-state.py':
            start = text.index('FALLBACK_EN = {')
            text = text[:start] + text[text.index('\n}\n', start) + 3:]
        out[os.path.basename(path)] = text
    return out


class NormalizeTests(unittest.TestCase):
    def test_tags(self):
        cases = {
            'en': 'en', 'en-US': 'en', 'EN_gb': 'en', 'fr': 'en', 'de-DE': 'en', 'C': 'en', 'POSIX': 'en', '': 'en', None: 'en',
            'zh-TW': 'zh-TW', 'zh_TW.UTF-8': 'zh-TW', 'zh-HK': 'zh-TW', 'zh-MO': 'zh-TW', 'zh-Hant': 'zh-TW',
            'zh-Hant-TW': 'zh-TW', 'zh-hant-hk': 'zh-TW', 'zh_Hant_TW.UTF-8': 'zh-TW',
            'zh': 'zh-CN', 'zh-CN': 'zh-CN', 'zh-SG': 'zh-CN', 'zh-Hans': 'zh-CN', 'zh-Hans-CN': 'zh-CN', 'zh_CN.GB2312': 'zh-CN',
            'ja': 'ja', 'ja-JP': 'ja', 'ja_JP.UTF-8': 'ja', 'ko': 'ko', 'ko-KR': 'ko', 'ko_KR.eucKR': 'ko',
            'kok': 'en', 'jam': 'en', 'zh-XX': 'en', '  zh-TW  ': 'zh-TW',
        }
        for tag, want in cases.items():
            with self.subTest(tag=tag):
                self.assertEqual(i18n.normalize(tag), want)

    def test_names(self):
        cases = {
            'English': 'en', 'Japanese': 'ja', '日本語': 'ja', 'Korean': 'ko', '한국어': 'ko',
            'Traditional Chinese': 'zh-TW', 'Chinese (Traditional)': 'zh-TW', '繁體中文': 'zh-TW', '臺灣繁體中文': 'zh-TW',
            'Simplified Chinese': 'zh-CN', 'Chinese (Simplified)': 'zh-CN', '简体中文': 'zh-CN', 'Chinese': 'zh-CN',
            # Claude Code's `language` outside the five catalogs falls back to English.
            'français': 'en', 'Deutsch': 'en', 'Español': 'en',
        }
        for name, want in cases.items():
            with self.subTest(name=name):
                self.assertEqual(i18n.normalize(name), want)

    def test_every_locale_is_its_own_normal_form(self):
        self.assertEqual(i18n.LOCALES, ('en', 'zh-TW', 'zh-CN', 'ja', 'ko'))
        for locale in i18n.LOCALES:
            self.assertEqual(i18n.normalize(locale), locale)


class ResolveTests(unittest.TestCase):
    def test_the_flag_wins_then_the_env_then_english(self):
        self.assertEqual(i18n.resolve(None, {}), 'en')
        self.assertEqual(i18n.resolve(None, {'DECKHAND_LANG': 'ja_JP.UTF-8'}), 'ja')
        self.assertEqual(i18n.resolve('ko', {'DECKHAND_LANG': 'ja'}), 'ko')
        self.assertEqual(i18n.resolve('', {'DECKHAND_LANG': 'zh-Hant'}), 'zh-TW', 'an empty flag is no flag')
        self.assertEqual(i18n.resolve('fr', {'DECKHAND_LANG': 'ja'}), 'en', 'a flag that is given wins, even when unknown')
        self.assertEqual(i18n.resolve(None, {'DECKHAND_LANG': '  '}), 'en')


class TranslateTests(unittest.TestCase):
    def test_placeholders_are_filled(self):
        self.assertEqual(i18n.t('en', 'handoff.age.minutes', count=3), '3 min ago')
        self.assertEqual(i18n.t('zh-TW', 'handoff.age.minutes', count=3), '3 分鐘前')
        self.assertEqual(i18n.t('ja_JP', 'handoff.age.minutes', count=3), '3 分前', 'the locale is normalized')
        self.assertEqual(i18n.t('fr', 'handoff.age.minutes', count=3), '3 min ago')

    def test_an_unknown_key_raises(self):
        with self.assertRaises(KeyError):
            i18n.t('en', 'delegate.no_such_message')
        with self.assertRaises(KeyError):
            i18n.t('zh-TW', 'no.such.key')

    def test_a_missing_value_raises(self):
        with self.assertRaises(KeyError):
            i18n.t('en', 'handoff.age.minutes')

    def test_join_uses_the_locales_separator(self):
        self.assertEqual(i18n.join('en', [1, 2, 3]), '1, 2, 3')
        self.assertEqual(i18n.join('zh-TW', [1, 2]), '1、2')
        self.assertEqual(i18n.join('ja', ['a', 'b']), 'a、b')
        self.assertEqual(i18n.join('ko', ['a', 'b']), 'a, b')

    def test_not_posix_refuses_only_off_posix_in_every_locale(self):
        self.assertIsNone(i18n.not_posix('en'))
        with mock.patch.object(i18n.os, 'name', 'nt'):
            texts = {locale: i18n.not_posix(locale) for locale in i18n.LOCALES}
        for locale, text in texts.items():
            with self.subTest(locale=locale):
                self.assertIn('macOS', text)
                self.assertIn('Linux', text)
                self.assertIn(sys.platform, text)
                self.assertNotIn('\n', text)
        self.assertEqual(len(set(texts.values())), len(i18n.LOCALES))


class CompletenessTests(unittest.TestCase):
    def test_every_locale_has_a_catalog(self):
        self.assertEqual(sorted(i18n.CATALOG), sorted(i18n.LOCALES))

    def test_every_key_is_in_every_locale_with_the_same_placeholders(self):
        english = i18n.CATALOG['en']
        for locale in i18n.LOCALES:
            table = i18n.CATALOG[locale]
            with self.subTest(locale=locale):
                self.assertEqual(sorted(set(english) - set(table)), [], 'missing in %s' % locale)
                self.assertEqual(sorted(set(table) - set(english)), [], 'unknown in %s' % locale)
            for key, text in table.items():
                with self.subTest(locale=locale, key=key):
                    self.assertIsInstance(text, str)
                    self.assertTrue(text.strip(), 'empty message')
                    self.assertEqual(fields(text), fields(english[key]))
                    filled = i18n.t(locale, key, **{name: 'X' for name in fields(text)})
                    self.assertNotIn('{', filled.replace('{X', ''), 'a stray brace')

    def test_every_key_the_scripts_use_exists_and_every_key_is_used(self):
        used = set()
        for name, source in script_sources().items():
            keys = set(KEY_LITERAL.findall(source))
            if name != 'i18n.py':
                self.assertTrue(keys, '%s uses no message' % name)
            used |= keys
        known = set(i18n.CATALOG['en'])
        self.assertEqual(sorted(used - known), [], 'keys used but not in the catalog')
        self.assertEqual(sorted(known - used), [], 'keys in the catalog that no script uses')

    def test_language_names_are_endonyms(self):
        names = {'en': 'English', 'zh-TW': '臺灣繁體中文', 'zh-CN': '简体中文', 'ja': '日本語', 'ko': '한국어'}
        self.assertEqual({locale: i18n.t(locale, 'language.name') for locale in i18n.LOCALES}, names)

    def test_the_two_chinese_catalogs_are_not_swapped(self):
        simplified, traditional = '这说为时个设认项实获',  '這說為時個設認項實獲'
        for key, text in i18n.CATALOG['zh-TW'].items():
            self.assertFalse(set(text) & set(simplified), 'zh-TW %s: %s' % (key, text))
        for key, text in i18n.CATALOG['zh-CN'].items():
            self.assertFalse(set(text) & set(traditional), 'zh-CN %s: %s' % (key, text))

    def test_zh_tw_uses_taiwan_terms_and_full_width_punctuation(self):
        for key, text in i18n.CATALOG['zh-TW'].items():
            with self.subTest(key=key):
                for mainland in ('文件夹', '文件夾', '默认', '默認', '软件', '軟件', '設置', '设置', '程序員', '信息', '用戶'):
                    self.assertNotIn(mainland, text)
                self.assertFalse(re.search(r'[一-鿿][,;:?!]|[,;:?!][一-鿿]', text), 'half-width punctuation next to Chinese')

    def test_the_commands_inside_messages_are_kept_in_every_locale(self):
        must_keep = {
            'sub5.cleanup.deleted_branch': 'git branch {branch} {sha}',
            'sub5.clean.deleted_branch': 'git branch {branch} {sha}',
            'handoff.prompt.check_first': 'python3 {tool} check --from {source} --to {target} --lang {lang}',
            'sub5.apply.hint': '--three-way',
            'sub5.cleanup.processes_running': '--stop-processes',
            'delegate.err.secret': '<REDACTED>',
            'delegate.err.no_brief': '--prompt-file',
        }
        for key, part in must_keep.items():
            for locale in i18n.LOCALES:
                with self.subTest(key=key, locale=locale):
                    self.assertIn(part, i18n.CATALOG[locale][key])

    def test_no_script_prints_chinese_outside_the_catalog(self):
        for name, source in script_sources().items():
            if name == 'i18n.py':
                continue
            with self.subTest(script=name):
                self.assertFalse(re.findall(r'[぀-ヿ㐀-鿿가-힯]', source))


class BytecodeTests(unittest.TestCase):
    def test_running_the_scripts_leaves_no_pycache_next_to_them(self):
        tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        copy = os.path.join(tmp, 'bin')
        os.makedirs(copy)
        for path in glob.glob(os.path.join(BIN, '*.py')):
            shutil.copy(path, copy)
        env = {k: v for k, v in os.environ.items() if k not in ('PYTHONDONTWRITEBYTECODE', 'PYTHONPYCACHEPREFIX', 'DECKHAND_LANG')}
        env.update(HOME=tmp, PATH=os.environ.get('PATH', ''))
        runs = [
            ['delegate.py', 'check', '--tool', 'agy', '--bin', os.path.join(tmp, 'none')],
            ['sub5.py', 'status', '--cwd', tmp],
            ['handoff-state.py', 'state', '--no-pr', '--cwd', tmp],
            ['codex-threads.py', '--codex-home', tmp],
        ]
        for argv in runs:
            done = subprocess.run([sys.executable, os.path.join(copy, argv[0])] + argv[1:], cwd=tmp, env=env,
                                  capture_output=True, text=True, timeout=60)
            self.assertNotIn('Traceback', done.stderr, argv)
        self.assertEqual(sorted(os.listdir(copy)), sorted(os.path.basename(p) for p in glob.glob(os.path.join(BIN, '*.py'))))


if __name__ == '__main__':
    unittest.main()
