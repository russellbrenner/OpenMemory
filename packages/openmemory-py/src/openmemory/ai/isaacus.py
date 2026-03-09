from typing import List, Dict, Any
from ..core.config import env
from .adapter import AIAdapter


class IsaacusAdapter(AIAdapter):
    """
    Isaacus kanon-2-embedder adapter for OpenMemory.

    Uses:
      - kanon-2-embedder for embeddings (1,792 dims by default)
      - No chat capability -- raises NotImplementedError

    Config env vars:
      OM_ISAACUS_API_KEY  -- required
      OM_ISAACUS_MODEL    -- embedding model ID (default: kanon-2-embedder)
    """

    def __init__(self, api_key: str = None):
        import os
        from isaacus import Isaacus
        self.api_key = api_key or env.isaacus_key or os.environ.get("OM_ISAACUS_API_KEY") or os.environ.get("ISAACUS_API_KEY")
        if not self.api_key:
            raise RuntimeError("ISAACUS_API_KEY or OM_ISAACUS_API_KEY must be set for Isaacus provider")
        self.model = getattr(env, "isaacus_embedding_model", None) or "kanon-2-embedder"
        self.dim = env.vec_dim or 1792
        self._client = Isaacus(api_key=self.api_key)

    async def chat(self, messages: List[Dict[str, str]], model: str = None, **kwargs) -> str:
        raise NotImplementedError("Isaacus does not provide a chat/completion API")

    async def embed(self, text: str, model: str = None) -> List[float]:
        m = model or self.model
        response = self._client.embeddings.create(
            model=m,
            texts=[text],
            task="retrieval/document",
            dimensions=self.dim,
        )
        return response.embeddings[0].embedding

    async def embed_batch(self, texts: List[str], model: str = None) -> List[List[float]]:
        if not texts:
            return []
        m = model or self.model
        BATCH = 128
        results: List[List[float]] = []
        for i in range(0, len(texts), BATCH):
            batch = texts[i : i + BATCH]
            response = self._client.embeddings.create(
                model=m,
                texts=batch,
                task="retrieval/document",
                dimensions=self.dim,
            )
            results.extend([e.embedding for e in response.embeddings])
        return results
