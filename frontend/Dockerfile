# Frontend nginx — RadioLocal-VHF-HF (Fase 0)
FROM nginx:alpine

# Reemplazar la config por defecto de nginx.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copiar los estáticos del frontend.
COPY public /usr/share/nginx/html

EXPOSE 80
