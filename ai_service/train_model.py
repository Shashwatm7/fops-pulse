import json
import pickle
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import Pipeline
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, classification_report

# ==========================================
# HAM (Relevant Business / Market / Supply Chain)
# ==========================================
ham_docs = [
    'Wheat futures surge on drought concerns in the Midwest',
    'OPEC announces cut in oil production, affecting global crude prices',
    'Dairy commodity prices fall due to oversupply in the domestic market',
    'Class III milk futures drop $3, market awaits rebound',
    'Soybean harvest yields lower than expected, driving up global spot prices',
    'Global fertilizer shortage threatens corn yields this planting season',
    'Coffee arabica prices hit 10-year high as Brazilian harvest falters',
    'Milk powder prices surge in Middle East amid supply chain tightening',
    'Butter prices reach record levels in Europe due to lower milk output',
    'Cheese exports from New Zealand decline for fourth consecutive quarter',
    'Logistics bottlenecks at major ports delay supply chains',
    'New export regulations disrupt cross-border freight traffic',
    'Cargo theft rings target high-value electronics in transit',
    'US intermodal volume up, but rail freight speeds crash',
    'Shipping giants announce major rate hikes for Asia-Europe routes',
    'Cross-border freight rebounds ahead of critical USMCA review',
    'CMA CGM to acquire FedEx Supply Chain and collaborate on airfreight',
    'USMCA cross-border freight faces uncertainty amid trade negotiations',
    'Freight derailment disrupts supply routes in the Midwest',
    'Strategic cargo theft now accounts for nearly a third of all US incidents',
    'How managed transportation helps food companies build resilient freight networks',
    'Port congestion worsens as container ships queue at Los Angeles terminal',
    'Air cargo volumes surge as e-commerce demand strains global logistics',
    'Tanker tracker says cargo ship in Hormuz has been stuck since March',
    'Cargo ship runs aground in the Strait of Hormuz disrupting oil trade',
    'Inflation impacts consumer spending, forcing retailers to slash inventory',
    'Milk Producers Federation lobbies trade policy in Washington',
    'New tariffs on dairy imports threaten Middle East supply agreements',
    'Government announces subsidy cuts for agricultural sector amid fiscal constraints',
    'EU imposes stricter regulations on food imports affecting global supply chains',
    'US trade representative proposes new rules for agricultural commodities',
    'Dairy Trends: markets still in the doldrums',
    'Milk prices improve, but outlook remains uncertain',
    'cheese cold storage inventories Milk Futures Crash When Will the Bleeding Stop',
    'Dairy Production Margins Improve but Milk Prices Remain Low',
    'UK Milk Prices See Increment Despite Continued Market Uncertainty',
    'Milk market expected to turn quiet',
    'Dairy Prices Fall: Butter, Cheddar, Dry Whey, and Nonfat Dry Milk Down',
    'Milk prices decrease; other consumer staples steady',
    'Adams Warehouse highlights integrated Houston drayage services for port and rail freight',
    'Electrifying on-road freight: tractor-trailer deployment by a beverage company',
    'Old Dominion Freight Line stock after its market rally',
    'Cattle feed plant GM and firm owners booked for misuse of subsidised urea',
    'Multiple Idaho dairy farms under quarantine as bird flu spreads through the region',
    'IDFA urges advisory board to support temporary exemptions for dairy packaging',
    'Verisk CargoNet warns freight disruptions could amplify cargo theft risk',
    'Global dairy trade auction prices decline for third consecutive session',
    'Major poultry processor announces plant closures due to avian influenza outbreak'
]

# ==========================================
# SPAM (Consumer Noise, Recipes, Local News, Opinion, Health)
# ==========================================
spam_docs = [
    '10 best ways to use milk in baking and recipes',
    'Local dairy farm wins state fair award for best cheese',
    'How to make the perfect chocolate cake using fresh dairy ingredients',
    'The Wantagh Dairy Mart announces its grand opening in August',
    'Hoover Dairy announces fair-ly new ice cream flavor winner',
    'Kitchen workshops stress dairy role in health and nutrition',
    'Governor visits Meyer Dairy Farm for a photo op',
    'Did the milk expire? California bans sell by food labels',
    'Whole goat milk formula can reduce incidence of atopic dermatitis in infants',
    'Got Milk docuseries looking at impact of iconic marketing campaign',
    'For a better bourbon experience grab a tiny gadget you might already own',
    'This Western Mass farm combines pizza hard cider and a chance to feed farm animals',
    'Byrne Dairy is ready to open its newest store in Onondaga County',
    'Cash dairy prices remain mostly unchanged Wednesday',
    'World Dairy Expo cattle show entries now open',
    'Valley mom donates nearly 7 gallons of breast milk to help NICU babies',
    'PFAS found in all Dutch breast milk samples study finds',
    'Virginia first milk depot helps fill a critical healthcare gap',
    'Raw milk yes or no debate continues among health advocates',
    'Nominate dairies for NMC National Dairy Quality Awards Program',
    'Maureen Harkcom thoughts on raw milk from the child of a dairy farm',
    'Driggs local shares journey toward kickstarting permitted raw milk dairy',
    'Hobart crash one killed after freight train hits car near 3rd Colorado streets',
    'Truck driver accused of using fake documents to steal cargo',
    'Big-time cargo theft bust for small-town Indiana police',
    'US and Iran hold separate meetings in Qatar and agree to continue discussions'
]

def main():
    X = ham_docs + spam_docs
    y = ['ham'] * len(ham_docs) + ['spam'] * len(spam_docs)

    print(f"Total documents: {len(X)}")
    print(f"Ham: {len(ham_docs)} | Spam: {len(spam_docs)}")

    # 1. Train/Test Split (80% train, 20% test)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
    
    print(f"\nTraining on {len(X_train)} samples, testing on {len(X_test)} samples...")

    # 2. Build Pipeline (TF-IDF Vectorizer + Naive Bayes Classifier)
    pipeline = Pipeline([
        ('tfidf', TfidfVectorizer(stop_words='english', lowercase=True)),
        ('clf', MultinomialNB())
    ])

    # 3. Train the model
    pipeline.fit(X_train, y_train)

    # 4. Evaluate the model on the test split
    y_pred = pipeline.predict(X_test)
    accuracy = accuracy_score(y_test, y_pred)
    
    print(f"\n✅ Model Evaluation on Test Split:")
    print(f"Accuracy: {accuracy * 100:.2f}%\n")
    print(classification_report(y_test, y_pred))

    # 5. Save the trained pipeline
    model_path = "pipeline/classifier.pkl"
    with open(model_path, 'wb') as f:
        pickle.dump(pipeline, f)
        
    print(f"✅ TF-IDF ML Classifier successfully trained and saved to: {model_path}")

if __name__ == "__main__":
    main()
