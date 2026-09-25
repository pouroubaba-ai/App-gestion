'use client';

/**
 * Rendu EAN-13 en SVG.
 * Les 12 premiers chiffres sont encodés ; le 13e est la clé de contrôle.
 * Le premier chiffre n'a pas de barres : il détermine l'alternance L/G
 * des six chiffres de gauche, ce qui permet au lecteur de savoir dans quel
 * sens l'étiquette a été scannée.
 */

const L: Record<string, string> = {
  '0': '0001101', '1': '0011001', '2': '0010011', '3': '0111101', '4': '0100011',
  '5': '0110001', '6': '0101111', '7': '0111011', '8': '0110111', '9': '0001011',
};
const G: Record<string, string> = {
  '0': '0100111', '1': '0110011', '2': '0011011', '3': '0100001', '4': '0011101',
  '5': '0111001', '6': '0000101', '7': '0010001', '8': '0001001', '9': '0010111',
};
const R: Record<string, string> = {
  '0': '1110010', '1': '1100110', '2': '1101100', '3': '1000010', '4': '1011100',
  '5': '1001110', '6': '1010000', '7': '1000100', '8': '1001000', '9': '1110100',
};

/** Quel motif (L ou G) pour chacun des 6 chiffres de gauche, selon le 1er chiffre. */
const PARITE: Record<string, string> = {
  '0': 'LLLLLL', '1': 'LLGLGG', '2': 'LLGGLG', '3': 'LLGGGL', '4': 'LGLLGG',
  '5': 'LGGLLG', '6': 'LGGGLL', '7': 'LGLGLG', '8': 'LGLGGL', '9': 'LGGLGL',
};

interface Props {
  valeur: string;
  hauteur?: number;
  largeurBarre?: number;
  afficherTexte?: boolean;
}

export default function CodeBarre({
  valeur,
  hauteur = 60,
  largeurBarre = 2,
  afficherTexte = true,
}: Props) {
  const code = valeur.replace(/\D/g, '');
  if (code.length !== 13) {
    return <p className="text-xs text-gray-400">{valeur || '—'}</p>;
  }

  const parite = PARITE[code[0]];
  /* garde + 6 chiffres gauche + séparateur central + 6 chiffres droite + garde */
  let motif = '101';
  for (let i = 0; i < 6; i++) {
    motif += (parite[i] === 'L' ? L : G)[code[i + 1]];
  }
  motif += '01010';
  for (let i = 7; i < 13; i++) {
    motif += R[code[i]];
  }
  motif += '101';

  /* les barres de garde descendent plus bas, pour laisser la place au texte */
  const estGarde = (i: number) =>
    i < 3 || (i >= 45 && i < 50) || i >= motif.length - 3;

  const marge = largeurBarre * 5;
  const hautTexte = afficherTexte ? 14 : 0;
  const largeur = motif.length * largeurBarre + marge * 2;
  const hauteurTotale = hauteur + hautTexte;

  return (
    <svg width={largeur} height={hauteurTotale} viewBox={`0 0 ${largeur} ${hauteurTotale}`}
      className="max-w-full" shapeRendering="crispEdges">
      <rect width={largeur} height={hauteurTotale} fill="#fff" />
      {motif.split('').map((bit, i) =>
        bit === '1' ? (
          <rect key={i}
            x={marge + i * largeurBarre}
            y={0}
            width={largeurBarre}
            height={estGarde(i) ? hauteur + hautTexte * 0.45 : hauteur}
            fill="#000" />
        ) : null
      )}
      {afficherTexte && (
        <>
          <text x={marge - largeurBarre} y={hauteurTotale - 1} fontSize={11} textAnchor="end" fill="#000" fontFamily="monospace">
            {code[0]}
          </text>
          <text x={marge + 25 * largeurBarre} y={hauteurTotale - 1} fontSize={11} textAnchor="middle" fill="#000" fontFamily="monospace" letterSpacing={largeurBarre * 0.8}>
            {code.slice(1, 7)}
          </text>
          <text x={marge + 71 * largeurBarre} y={hauteurTotale - 1} fontSize={11} textAnchor="middle" fill="#000" fontFamily="monospace" letterSpacing={largeurBarre * 0.8}>
            {code.slice(7)}
          </text>
        </>
      )}
    </svg>
  );
}
