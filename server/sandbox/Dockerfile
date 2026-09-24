# Bac à sable d'analyse du copilote (server/mcp-sandbox.mjs).
# Lancé sans réseau, en lecture seule, avec /work monté depuis le relay.
FROM python:3.12-slim
ENV PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLBACKEND=Agg MPLCONFIGDIR=/tmp/mpl
RUN pip install --no-cache-dir \
      pandas==2.2.3 numpy==2.1.3 matplotlib==3.9.2 scipy==1.14.1 \
      openpyxl==3.1.5 xlsxwriter==3.2.0 pypdf==5.1.0 python-docx==1.1.2 python-pptx==1.0.2 \
      pyarrow==18.1.0 tabulate==0.9.0 python-dateutil==2.9.0.post0
RUN useradd -u 1000 -m sandbox && mkdir -p /work && chown sandbox:sandbox /work
USER sandbox
WORKDIR /work
CMD ["python3"]
