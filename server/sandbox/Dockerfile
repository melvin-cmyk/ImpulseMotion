# Bac à sable d'analyse du copilote (server/mcp-sandbox.mjs).
# Lancé sans réseau, en lecture seule, avec /work monté depuis le relay et
# /skills (skills HQ synchronisées, assets de DA compris) monté en lecture seule.
#
# Python (analyse, python-pptx), Node + pptxgenjs (decks à la DA Impulse, cf.
# skill slides-impulse), LibreOffice + poppler (rendu PPTX → PDF → images pour
# le QA visuel), polices Mulish et Open Sans (DA Impulse).
#
# Reconstruire : docker build -t impulsemotion-sandbox:latest server/sandbox
FROM node:20-slim AS node

FROM python:3.12-slim
ENV PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLBACKEND=Agg MPLCONFIGDIR=/tmp/mpl \
    NODE_PATH=/usr/local/lib/node_modules
RUN pip install --no-cache-dir \
      pandas==2.2.3 numpy==2.1.3 matplotlib==3.9.2 scipy==1.14.1 \
      openpyxl==3.1.5 xlsxwriter==3.2.0 pypdf==5.1.0 python-docx==1.1.2 python-pptx==1.0.2 \
      pyarrow==18.1.0 tabulate==0.9.0 python-dateutil==2.9.0.post0 fonttools==4.55.3 pillow==11.0.0

# LibreOffice (rendu PPTX/DOCX → PDF), poppler (PDF → images), polices.
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libreoffice-impress-nogui libreoffice-calc-nogui libreoffice-writer-nogui \
      poppler-utils fonts-open-sans fonts-liberation fonts-dejavu-core fontconfig curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Mulish (Google Fonts, variable) → instances statiques avec un nom de famille
# lisible par LibreOffice/PowerPoint : « Mulish », « Mulish Black », etc.
RUN mkdir -p /usr/local/share/fonts/mulish && cd /usr/local/share/fonts/mulish \
    && curl -fsSL -o Mulish-VF.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/mulish/Mulish%5Bwght%5D.ttf" \
    && for w in 400:Regular 700:Bold 800:ExtraBold 900:Black 300:Light; do \
         fonttools varLib.instancer --update-name-table -o "Mulish-${w#*:}.ttf" Mulish-VF.ttf "wght=${w%%:*}"; \
       done \
    && rm Mulish-VF.ttf && fc-cache -f \
    && fc-list | grep -i mulish

# Node 20 + pptxgenjs (global, résolu via NODE_PATH).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && npm install -g --omit=dev pptxgenjs@3.12.0 \
    && node -e "require('pptxgenjs'); console.log('pptxgenjs OK')" \
    && rm -rf /root/.npm

RUN useradd -u 1000 -m sandbox && mkdir -p /work /skills && chown sandbox:sandbox /work
USER sandbox
WORKDIR /work
CMD ["python3"]
