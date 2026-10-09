interface HandVisualizationProps {
  activeFingerIndex: number;
  isFingerPressed: boolean;
  useLeftHand?: boolean;
}

export function HandVisualization({
  activeFingerIndex,
  isFingerPressed,
  useLeftHand = false, // predvolene pravá ruka
}: HandVisualizationProps) {
  // Farba prsta podľa stavu
  const getFingerColor = (index: number) => {
    if (index === activeFingerIndex) {
      return isFingerPressed ? '#22c55e' : '#fb923c'; // zelená ak stlačený, oranžová ak aktívny
    }
    return '#d1d5db'; // sivá pre neaktívne
  };

  return (
    <svg
      viewBox="0 0 280 320"
      className="w-full h-auto"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      // ak je ľavá ruka, zrkadlovo otočíme SVG
      style={{
        transform: useLeftHand ? 'scaleX(-1)' : 'scaleX(1)',
        transformOrigin: 'center',
      }}
    >
      <g transform="rotate(-15 140 160)">
        {/* Dlaň */}
        <ellipse
          cx="140"
          cy="200"
          rx="55"
          ry="70"
          fill="#d1d5db"
          stroke="#9ca3af"
          strokeWidth="2"
        />

        {/* Zápästie */}
        <rect
          x="115"
          y="250"
          width="50"
          height="40"
          rx="10"
          fill="#d1d5db"
          stroke="#9ca3af"
          strokeWidth="2"
        />

        {/* Palec */}
        <g transform="translate(80, 190)">
          <path
            d="M 0 0 Q -10 -15, -5 -35 Q 0 -50, 8 -55 Q 16 -50, 18 -35 Q 20 -15, 12 0 Z"
            fill={getFingerColor(0)}
            stroke="#9ca3af"
            strokeWidth="2"
          />
          <ellipse
            cx="3"
            cy="-55"
            rx="10"
            ry="14"
            fill={getFingerColor(0)}
            stroke="#9ca3af"
            strokeWidth="2"
          />
        </g>

        {/* Ukazovák */}
        <g transform="translate(110, 130)">
          <path
            d="M 0 0 Q -3 -30, 0 -50 L 0 -70 Q 0 -75, 5 -75 Q 10 -75, 10 -70 L 10 -50 Q 13 -30, 10 0 Z"
            fill={getFingerColor(1)}
            stroke="#9ca3af"
            strokeWidth="2"
          />
          <ellipse
            cx="5"
            cy="-75"
            rx="7"
            ry="10"
            fill={getFingerColor(1)}
            stroke="#9ca3af"
            strokeWidth="2"
          />
        </g>

        {/* Prostredník */}
        <g transform="translate(135, 120)">
          <path
            d="M 0 0 Q -3 -35, 0 -60 L 0 -85 Q 0 -90, 5 -90 Q 10 -90, 10 -85 L 10 -60 Q 13 -35, 10 0 Z"
            fill={getFingerColor(2)}
            stroke="#9ca3af"
            strokeWidth="2"
          />
          <ellipse
            cx="5"
            cy="-90"
            rx="7"
            ry="10"
            fill={getFingerColor(2)}
            stroke="#9ca3af"
            strokeWidth="2"
          />
        </g>

        {/* Prstenník */}
        <g transform="translate(160, 125)">
          <path
            d="M 0 0 Q -3 -32, 0 -55 L 0 -75 Q 0 -80, 5 -80 Q 10 -80, 10 -75 L 10 -55 Q 13 -32, 10 0 Z"
            fill={getFingerColor(3)}
            stroke="#9ca3af"
            strokeWidth="2"
          />
          <ellipse
            cx="5"
            cy="-80"
            rx="7"
            ry="10"
            fill={getFingerColor(3)}
            stroke="#9ca3af"
            strokeWidth="2"
          />
        </g>

        {/* Malíček */}
        <g transform="translate(185, 140)">
          <path
            d="M 0 0 Q -3 -25, 0 -40 L 0 -55 Q 0 -60, 5 -60 Q 10 -60, 10 -55 L 10 -40 Q 13 -25, 10 0 Z"
            fill={getFingerColor(4)}
            stroke="#9ca3af"
            strokeWidth="2"
          />
          <ellipse
            cx="5"
            cy="-60"
            rx="6"
            ry="9"
            fill={getFingerColor(4)}
            stroke="#9ca3af"
            strokeWidth="2"
          />
        </g>
      </g>
    </svg>
  );
}
