// FadeImage.tsx - <img> that fades in once decoded, so posters don't pop in
// half-drawn while a rail scrolls. Failed images simply stay invisible and
// let the placeholder behind them show.
import React, { useState } from 'react';

interface FadeImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'onError'> {
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
}

export const FadeImage: React.FC<FadeImageProps> = ({ className, onLoad, ...rest }) => {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      {...rest}
      decoding="async"
      draggable={false}
      className={`fade-img${loaded ? ' loaded' : ''}${className ? ` ${className}` : ''}`}
      onLoad={e => {
        setLoaded(true);
        onLoad?.(e);
      }}
    />
  );
};
