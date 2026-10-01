// Accurate classic post-LN Encoder example. M is optional padding/additive mask.
export const attentionMath=String.raw`$$\begin{aligned}
Q_i&=XW_i^Q,\quad K_i=XW_i^K,\quad V_i=XW_i^V\\
S_i&=\frac{Q_iK_i^\top}{\sqrt{d_k}}+M\\
H_i&=\mathrm{softmax}(S_i)V_i\\
\mathrm{MHA}(X)&=\mathrm{Concat}(H_1,\ldots,H_h)W^O\\
Z&=\mathrm{LN}\!\left(X+\mathrm{MHA}(X)\right)\\
Y&=\mathrm{LN}\!\left(Z+\mathrm{FFN}(Z)\right)
\end{aligned}$$`;
export const attentionMermaid=String.raw`flowchart TB
 X["X · n × d_model"] --> Q["Q_i = XW_i^Q"]
 X --> K["K_i = XW_i^K"]
 X --> V["V_i = XW_i^V"]
 Q --> A["Aᵢ = softmax<br/>(QᵢKᵢᵀ / √dₖ + M)"]
 K --> A
 A --> H["H_i = A_i V_i · n × d_k"]
 V --> H
 H --> C["Concat(H₁ … Hₕ) Wᴼ<br/>n × d_model"]`;
export const encoderDot=(l)=>`digraph Encoder {
 graph [rankdir=TB,bgcolor="transparent",pad="0.12",nodesep="0.35",ranksep="0.25",splines=polyline];
 node [shape=box,style="rounded",fontname="Arial",fontsize=18,margin="0.18,0.1",penwidth=1.4];
 edge [arrowsize=0.7,penwidth=1.3,fontname="Arial",fontsize=12];
 X [label="${l[0]}\\nE(token) + P(position)\\nn × d_model"];
 M [label="${l[1]}\\nh heads · Q / K / V\\nConcat(H_1…H_h) W_O"];
 A [label="${l[2]}\\nZ = LN(X + MHA(X))"];
 F [label="${l[3]}\\nLinear · ReLU · Linear\\nd → 4d → d"];
 B [label="${l[2]}\\nY = LN(Z + FFN(Z))"];
 Y [label="${l[4]}\\nn × d_model"];
 {rank=same; X; M;}\n {rank=same; A; F;}\n {rank=same; B; Y;}\n X -> M [constraint=false]; M -> A; A -> F [constraint=false]; F -> B; B -> Y [constraint=false];
 X:e -> A:e [label="residual",constraint=false];
 A:w -> B:w [label="residual",constraint=false];
}`;
