/**
 * Double Metaphone (Lawrence Philips, 2000).
 *
 * Returns two phonetic codes per word — a primary and an alternate — so words
 * with more than one plausible pronunciation can match either way. This is the
 * mechanism that lets a speech-to-text transcript of "a lena" match the
 * profile name "Aleena": both reduce to the same consonant skeleton.
 *
 * Pure and dependency-free so it can run on every interim transcript token
 * without touching the network.
 */

const VOWELS = 'AEIOUY';

/**
 * @param {string} input
 * @returns {[string, string]} [primary, alternate]
 */
export function doubleMetaphone(input) {
  const word = String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');

  if (!word) return ['', ''];

  const length = word.length;
  const last = length - 1;

  let primary = '';
  let alternate = '';
  let current = 0;

  // Out-of-range reads return a space, not an empty string. This mirrors the
  // original algorithm's space-padded buffer and is load-bearing: JavaScript's
  // `'AEIOUY'.includes('')` is *true*, so returning '' would make every
  // character-class test pass at word boundaries — silencing nothing and
  // leaving stray codes like SARAH -> "SRH" instead of "SR".
  const at = (i) => (i >= 0 && i < length ? word[i] : ' ');
  // A negative start must yield no match rather than clamping to 0, or
  // look-behind tests fire against the front of the word.
  const slice = (start, count) => (start < 0 ? '' : word.slice(start, start + count));
  const isVowel = (i) => VOWELS.includes(at(i));
  const startsWith = (i, ...options) => options.includes(slice(i, options[0].length));
  const add = (p, a = p) => {
    primary += p;
    alternate += a;
  };
  const has = (start, count, ...options) => options.includes(slice(start, count));

  // "Slavo-Germanic" spellings change how W, K and CZ are treated.
  const slavoGermanic = /W|K|CZ|WITZ/.test(word);

  // Silent first letters.
  if (has(0, 2, 'GN', 'KN', 'PN', 'WR', 'PS')) current = 1;

  // Initial X is pronounced like S ("Xavier").
  if (at(0) === 'X') {
    add('S');
    current = 1;
  }

  while (current < length) {
    const c = at(current);

    switch (c) {
      case 'A':
      case 'E':
      case 'I':
      case 'O':
      case 'U':
      case 'Y':
        // Only an initial vowel is voiced.
        if (current === 0) add('A');
        current += 1;
        break;

      case 'B':
        add('P');
        current += at(current + 1) === 'B' ? 2 : 1;
        break;

      case 'C':
        current = handleC();
        break;

      case 'D':
        if (has(current, 2, 'DG')) {
          if ('IEY'.includes(at(current + 2))) {
            add('J');
            current += 3;
          } else {
            add('TK');
            current += 2;
          }
        } else {
          add('T');
          current += has(current, 2, 'DT', 'DD') ? 2 : 1;
        }
        break;

      case 'F':
        add('F');
        current += at(current + 1) === 'F' ? 2 : 1;
        break;

      case 'G':
        current = handleG();
        break;

      case 'H':
        // Only pronounced between a vowel and a vowel, or word-initial.
        if ((current === 0 || isVowel(current - 1)) && isVowel(current + 1)) {
          add('H');
          current += 2;
        } else {
          current += 1;
        }
        break;

      case 'J':
        current = handleJ();
        break;

      case 'K':
        add('K');
        current += at(current + 1) === 'K' ? 2 : 1;
        break;

      case 'L':
        if (at(current + 1) === 'L') {
          // Spanish-style terminal LL is often silent in the alternate.
          const spanish =
            (current === length - 3 && has(current - 1, 4, 'ILLO', 'ILLA', 'ALLE')) ||
            ((has(last - 1, 2, 'AS', 'OS') || 'AO'.includes(at(last))) &&
              has(current - 1, 4, 'ALLE'));
          if (spanish) add('L', '');
          else add('L');
          current += 2;
        } else {
          add('L');
          current += 1;
        }
        break;

      case 'M':
        add('M');
        current +=
          (has(current - 1, 3, 'UMB') && (current + 1 === last || has(current + 2, 2, 'ER'))) ||
          at(current + 1) === 'M'
            ? 2
            : 1;
        break;

      case 'N':
        add('N');
        current += at(current + 1) === 'N' ? 2 : 1;
        break;

      case 'P':
        if (at(current + 1) === 'H') {
          add('F');
          current += 2;
        } else {
          add('P');
          current += 'PB'.includes(at(current + 1)) ? 2 : 1;
        }
        break;

      case 'Q':
        add('K');
        current += at(current + 1) === 'Q' ? 2 : 1;
        break;

      case 'R':
        // Terminal French -IER is silent in the primary ("Rogier").
        if (current === last && !slavoGermanic && has(current - 2, 2, 'IE') && !has(current - 4, 2, 'ME', 'MA')) {
          add('', 'R');
        } else {
          add('R');
        }
        current += at(current + 1) === 'R' ? 2 : 1;
        break;

      case 'S':
        current = handleS();
        break;

      case 'T':
        current = handleT();
        break;

      case 'V':
        add('F');
        current += at(current + 1) === 'V' ? 2 : 1;
        break;

      case 'W':
        current = handleW();
        break;

      case 'X':
        // Terminal French X is silent ("Breaux").
        if (!(current === last && (has(current - 3, 3, 'IAU', 'EAU') || has(current - 2, 2, 'AU', 'OU')))) {
          add('KS');
        }
        current += 'CX'.includes(at(current + 1)) ? 2 : 1;
        break;

      case 'Z':
        if (at(current + 1) === 'H') {
          add('J');
          current += 2;
        } else {
          const softer = has(current + 1, 2, 'ZO', 'ZI', 'ZA') || (slavoGermanic && current > 0 && at(current - 1) !== 'T');
          add('S', softer ? 'TS' : 'S');
          current += at(current + 1) === 'Z' ? 2 : 1;
        }
        break;

      default:
        current += 1;
        break;
    }
  }

  return [primary, alternate];

  // --- Letters with enough branching to deserve their own function ---------

  function handleC() {
    // Germanic "-ACH-" as in "Bach".
    if (current > 1 && !isVowel(current - 2) && has(current - 1, 3, 'ACH') && at(current + 2) !== 'I' && (at(current + 2) !== 'E' || has(current - 2, 6, 'BACHER', 'MACHER'))) {
      add('K');
      return current + 2;
    }

    if (current === 0 && has(current, 6, 'CAESAR')) {
      add('S');
      return current + 2;
    }

    if (has(current, 4, 'CHIA')) {
      add('K');
      return current + 2;
    }

    if (has(current, 2, 'CH')) {
      // "-CHAE-" as in "Michael".
      if (current > 0 && has(current, 4, 'CHAE')) {
        add('K', 'X');
        return current + 2;
      }

      const greekInitial =
        current === 0 &&
        (has(current + 1, 5, 'HARAC', 'HARIS') || has(current + 1, 3, 'HOR', 'HYM', 'HIA', 'HEM')) &&
        !has(0, 5, 'CHORE');

      const germanicOrGreek =
        greekInitial ||
        has(0, 4, 'VAN ', 'VON ') ||
        has(0, 3, 'SCH') ||
        has(current - 2, 6, 'ORCHES', 'ARCHIT', 'ORCHID') ||
        'TS'.includes(at(current + 2)) ||
        ((current === 0 || 'AOUE'.includes(at(current - 1))) &&
          'LRNMBHFVW '.includes(at(current + 2)));

      if (germanicOrGreek) {
        add('K');
      } else if (current > 0) {
        add(has(0, 2, 'MC') ? 'K' : 'X', 'K');
      } else {
        add('X');
      }
      return current + 2;
    }

    // "-CZ-" as in "Czerny".
    if (has(current, 2, 'CZ') && !has(current - 2, 4, 'WICZ')) {
      add('S', 'X');
      return current + 2;
    }

    // "-CIA-" as in "focaccia".
    if (has(current + 1, 3, 'CIA')) {
      add('X');
      return current + 3;
    }

    if (has(current, 2, 'CC') && !(current === 1 && at(0) === 'M')) {
      // "-CCIA-", "-CCE-", "-CCI-" are soft.
      if ('IEH'.includes(at(current + 2)) && !has(current + 2, 2, 'HU')) {
        if ((current === 1 && at(current - 1) === 'A') || has(current - 1, 5, 'UCCEE', 'UCCES')) {
          add('KS');
        } else {
          add('X');
        }
        return current + 3;
      }
      add('K');
      return current + 2;
    }

    if (has(current, 2, 'CK', 'CG', 'CQ')) {
      add('K');
      return current + 2;
    }

    if (has(current, 2, 'CI', 'CE', 'CY')) {
      add(has(current, 3, 'CIO', 'CIE', 'CIA') ? 'S' : 'S');
      return current + 2;
    }

    add('K');
    if (has(current + 1, 2, ' C', ' Q', ' G')) return current + 3;
    if ('CKQ'.includes(at(current + 1)) && !has(current + 1, 2, 'CE', 'CI')) return current + 2;
    return current + 1;
  }

  function handleG() {
    if (at(current + 1) === 'H') {
      if (current > 0 && !isVowel(current - 1)) {
        add('K');
        return current + 2;
      }

      if (current < 3 && current === 0) {
        add(at(current + 2) === 'I' ? 'J' : 'K');
        return current + 2;
      }

      // Silent in "-OUGH-", "-AUGH-", "right", "Hugh".
      const silent =
        (current > 1 && 'BHD'.includes(at(current - 2))) ||
        (current > 2 && 'BHD'.includes(at(current - 3))) ||
        (current > 3 && 'BH'.includes(at(current - 4)));
      if (silent) return current + 2;

      if (current > 2 && at(current - 1) === 'U' && 'CGLRT'.includes(at(current - 3))) {
        add('F');
        return current + 2;
      }
      if (current > 0 && at(current - 1) !== 'I') add('K');
      return current + 2;
    }

    if (at(current + 1) === 'N') {
      if (current === 1 && isVowel(0) && !slavoGermanic) {
        add('KN', 'N');
      } else if (!has(current + 2, 2, 'EY') && at(current + 1) !== 'Y' && !slavoGermanic) {
        add('N', 'KN');
      } else {
        add('KN');
      }
      return current + 2;
    }

    // "-LI-" as in "Tagliaro".
    if (has(current + 1, 2, 'LI') && !slavoGermanic) {
      add('KL', 'L');
      return current + 2;
    }

    // "-GES-", "-GEP-", "-GEB-" etc are hard.
    if (current === 0 && (at(current + 1) === 'Y' || has(current + 1, 2, 'ES', 'EP', 'EB', 'EL', 'EY', 'IB', 'IL', 'IN', 'IE', 'EI', 'ER'))) {
      add('K', 'J');
      return current + 2;
    }

    if ((has(current + 1, 2, 'ER') || at(current + 1) === 'Y') && !has(0, 6, 'DANGER', 'RANGER', 'MANGER') && !'EI'.includes(at(current - 1)) && !has(current - 1, 3, 'RGY', 'OGY')) {
      add('K', 'J');
      return current + 2;
    }

    if ('EIY'.includes(at(current + 1)) || has(current - 1, 4, 'AGGI', 'OGGI')) {
      if (has(0, 4, 'VAN ', 'VON ') || has(0, 3, 'SCH') || has(current + 1, 2, 'ET')) {
        add('K');
      } else if (has(current + 1, 4, 'IER ')) {
        add('J');
      } else {
        add('J', 'K');
      }
      return current + 2;
    }

    add('K');
    return current + (at(current + 1) === 'G' ? 2 : 1);
  }

  function handleJ() {
    // "Jose" / "San Jacinto" keep a Spanish H sound.
    if (has(current, 4, 'JOSE') || has(0, 4, 'SAN ')) {
      if ((current === 0 && at(current + 4) === ' ') || has(0, 4, 'SAN ')) add('H');
      else add('J', 'H');
      return current + 1;
    }

    if (current === 0) {
      add('J', 'A');
    } else if (isVowel(current - 1) && !slavoGermanic && 'AO'.includes(at(current + 1))) {
      add('J', 'H');
    } else if (current === last) {
      add('J', '');
    } else if (!'LTKSNMBZ'.includes(at(current + 1)) && !'SKL'.includes(at(current - 1))) {
      add('J');
    }

    return current + (at(current + 1) === 'J' ? 2 : 1);
  }

  function handleS() {
    // "Island", "Isle" — silent S.
    if (has(current - 1, 3, 'ISL', 'YSL')) return current + 1;

    if (current === 0 && has(current, 5, 'SUGAR')) {
      add('X', 'S');
      return current + 1;
    }

    if (has(current, 2, 'SH')) {
      if (has(current + 1, 4, 'HEIM', 'HOEK', 'HOLM', 'HOLZ')) add('S');
      else add('X');
      return current + 2;
    }

    // "-SIO-", "-SIA-" as in "Fransiscan".
    if (has(current, 3, 'SIO', 'SIA') || has(current, 4, 'SIAN')) {
      add(slavoGermanic ? 'S' : 'S', slavoGermanic ? 'S' : 'X');
      return current + 3;
    }

    if ((current === 0 && 'MNLW'.includes(at(current + 1))) || at(current + 1) === 'Z') {
      add('S', 'X');
      return current + (at(current + 1) === 'Z' ? 2 : 1);
    }

    if (has(current, 2, 'SC')) {
      if (at(current + 2) === 'H') {
        // Dutch-origin "-SCH-" is a hard SK.
        if (has(current + 3, 2, 'OO', 'ER', 'EN', 'UY', 'ED', 'EM')) {
          add(has(current + 3, 2, 'ER', 'EN') ? 'X' : 'SK', 'SK');
        } else if (current === 0 && !isVowel(3) && at(3) !== 'W') {
          add('X', 'S');
        } else {
          add('X');
        }
        return current + 3;
      }
      if ('IEY'.includes(at(current + 2))) {
        add('S');
        return current + 3;
      }
      add('SK');
      return current + 3;
    }

    // Terminal "-AIS" / "-OIS" is French and silent in the primary.
    if (current === last && has(current - 2, 2, 'AI', 'OI')) add('', 'S');
    else add('S');

    return current + ('SZ'.includes(at(current + 1)) ? 2 : 1);
  }

  function handleT() {
    if (has(current, 4, 'TION')) {
      add('X');
      return current + 3;
    }
    if (has(current, 3, 'TIA', 'TCH')) {
      add('X');
      return current + 3;
    }

    if (has(current, 2, 'TH') || has(current, 3, 'TTH')) {
      // "Thomas", "Thames" keep a hard T.
      if (has(current + 2, 2, 'OM', 'AM') || has(0, 4, 'VAN ', 'VON ') || has(0, 3, 'SCH')) {
        add('T');
      } else {
        add('0', 'T');
      }
      return current + 2;
    }

    add('T');
    return current + ('TD'.includes(at(current + 1)) ? 2 : 1);
  }

  function handleW() {
    // "-WR-" as in "wright".
    if (has(current, 2, 'WR')) {
      add('R');
      return current + 2;
    }

    if (current === 0 && (isVowel(current + 1) || has(current, 2, 'WH'))) {
      if (isVowel(current + 1)) add('A', 'F');
      else add('A');
      return current + 1;
    }

    // Polish "-EWSKI", "-OWSKI".
    if (
      (current === last && isVowel(current - 1)) ||
      has(current - 1, 5, 'EWSKI', 'EWSKY', 'OWSKI', 'OWSKY') ||
      has(0, 3, 'SCH')
    ) {
      add('', 'F');
      return current + 1;
    }

    if (has(current, 4, 'WICZ', 'WITZ')) {
      add('TS', 'FX');
      return current + 4;
    }

    return current + 1;
  }
}

/**
 * True when two words share any phonetic code. Empty codes never match, so
 * vowel-only or punctuation-only tokens can't produce false positives.
 */
export function phoneticallyEqual(a, b) {
  const [ap, aa] = doubleMetaphone(a);
  const [bp, ba] = doubleMetaphone(b);
  if (!ap && !aa) return false;
  if (!bp && !ba) return false;
  return (
    (!!ap && (ap === bp || ap === ba)) ||
    (!!aa && (aa === bp || aa === ba))
  );
}
