// FadeImage.tsx - <img> that fades in once decoded, so posters don't pop in
// half-drawn while a rail scrolls. Failed images simply stay invisible and
// let the placeholder behind them show.
import React, { useState } from 'react';

type FadeImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'onLoad' | 'onError'>;

export const FadeImage: React.FC<FadeImageProps> = ({ className, ...rest }) => {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      {...rest}
      decoding="async"
      draggable={false}
      className={`fade-img${loaded ? ' loaded' : ''}${className ? ` ${className}` : ''}`}
      onLoad={() => setLoaded(true)}
    />
  );
};
