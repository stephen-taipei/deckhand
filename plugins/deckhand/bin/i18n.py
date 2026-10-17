"""Messages of deckhand's helper scripts, in every locale the plugin ships.

  LOCALES                 the locales, 'en' first (the default and the fallback)
  normalize(tag)          a BCP 47 tag, a POSIX locale or a language name -> one of LOCALES
  resolve(flag, env)      the locale a script runs in: --lang, else env DECKHAND_LANG, else 'en'
  t(locale, key, **vars)  the message `key` in `locale`, with str.format placeholders filled
  not_posix(locale)       the refusal on a system other than macOS or Linux, else None

The catalogs are bin/locales/<locale>.json, one flat object of key -> message each, read the first
time a locale is used. A message a catalog lacks falls back to English.

Only human-readable text lives there. Machine-readable output (JSON field names, exit codes,
front-matter keys, states such as 'merged' or 'pending') never depends on the locale.

A key that exists in no catalog raises KeyError: that is a bug, and tests/test_i18n.py checks that
every key the scripts use exists in English, and that every catalog keeps the English placeholders.
"""

import json
import os
import re
import sys

# The same list, in the same order, as hooks/locales.ts (tests/test_i18n.py compares them).
LOCALES = (
    'en', 'zh-Hant-TW', 'zh-Hant', 'zh-Hant-HK', 'zh-Hans', 'ja', 'ko', 'vi', 'uk', 'tr', 'th', 'sv', 'sk',
    'ru', 'ro', 'pt', 'pt-BR', 'pl', 'nl', 'nb', 'my', 'ms', 'lo', 'km', 'it', 'id', 'hu', 'hr', 'hi', 'he',
    'fr', 'fil', 'fi', 'es', 'es-MX', 'el', 'de', 'da', 'cs', 'ca', 'ar',
)
DEFAULT = 'en'
ENV = 'DECKHAND_LANG'
_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'locales')

# Language names people type instead of a tag (compared without case, spaces, brackets, - and _).
_NAMES = {
    'english': 'en',
    'japanese': 'ja', '日本語': 'ja',
    'korean': 'ko', '한국어': 'ko', '韓國語': 'ko',
    'chinese': 'zh-Hans', '中文': 'zh-Hans',
    'simplifiedchinese': 'zh-Hans', 'chinesesimplified': 'zh-Hans', '简体中文': 'zh-Hans', '簡體中文': 'zh-Hans',
    'traditionalchinese': 'zh-Hant-TW', 'chinesetraditional': 'zh-Hant-TW', 'chinesetaiwan': 'zh-Hant-TW',
    'chinesehongkong': 'zh-Hant-HK', '繁體中文': 'zh-Hant-TW', '繁体中文': 'zh-Hant-TW', '正體中文': 'zh-Hant-TW',
    '臺灣繁體中文': 'zh-Hant-TW', '台灣繁體中文': 'zh-Hant-TW', '香港繁體中文': 'zh-Hant-HK',
}
_NAME_NOISE = re.compile(r'[\s()（）\[\]_\-]+')
_BY_TAG = dict((tag.lower(), tag) for tag in LOCALES)
# Other spellings of a language subtag: legacy codes and close relatives.
_LANGUAGE_ALIAS = {'iw': 'he', 'in': 'id', 'no': 'nb', 'nn': 'nb', 'tl': 'fil', 'jp': 'ja'}


def normalize(tag):
    """One of LOCALES for a language tag or name; 'en' for anything not recognized.

    zh-TW, zh-Hant-TW -> 'zh-Hant-TW'; zh-HK, zh-MO -> 'zh-Hant-HK'; zh-Hant -> 'zh-Hant';
    zh, zh-CN, zh-Hans, zh-SG -> 'zh-Hans'; pt-BR -> 'pt-BR', other pt -> 'pt'; es-ES and es -> 'es',
    other Spanish -> 'es-MX'. `_` works like `-`, and a POSIX suffix (.UTF-8, @euro) is ignored."""
    text = str(tag or '').strip()
    if not text:
        return DEFAULT
    name = _NAME_NOISE.sub('', text).lower()
    if name in _NAMES:
        return _NAMES[name]
    text = text.split('.', 1)[0].split('@', 1)[0]
    parts = [p for p in re.split(r'[-_]', text.lower()) if p]
    if not parts or not re.match(r'^[a-z]{2,3}$', parts[0]):
        return DEFAULT
    language, rest = _LANGUAGE_ALIAS.get(parts[0], parts[0]), parts[1:]
    if language == 'zh':
        if rest[:1] == ['hant'] and len(rest) == 1:
            return 'zh-Hant'
        if 'hk' in rest or 'mo' in rest:
            return 'zh-Hant-HK'
        if 'hant' in rest or 'tw' in rest:
            return 'zh-Hant-TW'
        return 'zh-Hans'
    if language == 'pt':
        return 'pt-BR' if 'br' in rest else 'pt'
    if language == 'es':
        return 'es-MX' if rest and 'es' not in rest else 'es'
    return _BY_TAG.get('-'.join([language] + rest)) or _BY_TAG.get(language) or DEFAULT


def resolve(flag=None, env=None):
    """The locale to run in: the --lang value when given, else DECKHAND_LANG, else 'en'."""
    env = os.environ if env is None else env
    for value in (flag, env.get(ENV)):
        if value is not None and str(value).strip():
            return normalize(value)
    return DEFAULT


class _Catalogs(dict):
    """locale -> its messages, read from bin/locales/<locale>.json on first use; a locale without a file has none."""

    def __missing__(self, locale):
        if locale not in LOCALES:
            raise KeyError(locale)
        try:
            with open(os.path.join(_DIR, locale + '.json'), encoding='utf-8') as f:
                table = json.load(f)
        except (OSError, ValueError):
            table = {}
        self[locale] = table
        return table

    def get(self, locale, default=None):
        return self[locale] if locale in LOCALES else default

    def __iter__(self):
        return iter(LOCALES)

    def __len__(self):
        return len(LOCALES)

    def keys(self):
        return list(LOCALES)


CATALOG = _Catalogs()


def t(locale, key, **values):
    """The message `key` in `locale` (falling back to English), formatted with `values`."""
    table = CATALOG.get(locale) or CATALOG.get(normalize(locale)) or {}
    text = table.get(key)
    if text is None:
        text = CATALOG[DEFAULT].get(key)
    if text is None:
        raise KeyError('deckhand i18n: unknown message key %r' % key)
    return text.format(**values)


def join(locale, items):
    """A list as one phrase, with the locale's list separator (', ' or '、')."""
    return t(locale, 'common.list_sep').join(str(item) for item in items)


def not_posix(locale):
    """The refusal for a system other than macOS or Linux, else None. delegate.py and sub5.py need
    POSIX (uids, fchmod, process groups, SIGTERM); without it they would fail halfway with a traceback."""
    if os.name == 'posix':
        return None
    return t(locale, 'common.err.not_posix', system=sys.platform)
