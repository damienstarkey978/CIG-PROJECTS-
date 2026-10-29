FROM caddy:2.9-alpine
RUN apk add --no-cache python3 tzdata
COPY Caddyfile /etc/caddy/Caddyfile
COPY analytics.py /analytics.py
COPY entrypoint.sh /entrypoint.sh
COPY index.html styles.css site.js /usr/share/caddy/
COPY images /usr/share/caddy/images
RUN chmod +x /entrypoint.sh
EXPOSE 8080
CMD ["/entrypoint.sh"]
